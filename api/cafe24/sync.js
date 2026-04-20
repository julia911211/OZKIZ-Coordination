// 카페24 정기구독 고객 동기화
// - subscription/shipments API 사용 (정기배송 신청 내역)
// - Vercel 크론이 매일 오전 10시(KST) 자동 실행
// - 수동 실행: https://v0-static-html-upload.vercel.app/api/cafe24/sync

import { createClient } from '@supabase/supabase-js';

const MALL_ID = process.env.CAFE24_MALL_ID;
const API_VERSION = '2026-03-01';

// 전화번호 정규화 (010-1234-5678 → 01012345678)
function normalizePhone(phone) {
  return (phone || '').replace(/[^0-9]/g, '');
}

// Supabase에서 저장된 토큰 가져오기 + 만료 시 갱신
async function getAccessToken(supabase) {
  const { data, error } = await supabase
    .from('cafe24_tokens')
    .select('*')
    .eq('id', 1)
    .single();

  if (error || !data) throw new Error('저장된 카페24 토큰이 없습니다. /api/cafe24/auth 에서 먼저 인증해주세요.');

  const now = new Date();
  const expiresAt = new Date(data.expires_at);
  const bufferMs = 5 * 60 * 1000;

  if (now < new Date(expiresAt.getTime() - bufferMs)) {
    return data.access_token;
  }

  // 리프레시 토큰으로 갱신
  const credentials = Buffer.from(
    `${process.env.CAFE24_CLIENT_ID}:${process.env.CAFE24_CLIENT_SECRET}`
  ).toString('base64');

  const refreshRes = await fetch(
    `https://${MALL_ID}.cafe24api.com/api/v2/oauth/token`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: data.refresh_token,
      }),
    }
  );

  if (!refreshRes.ok) {
    const errText = await refreshRes.text();
    throw new Error(`토큰 갱신 실패: ${errText} — /api/cafe24/auth 에서 재인증 필요`);
  }

  const newTokens = await refreshRes.json();
  const newExpires = new Date(Date.now() + newTokens.expires_in * 1000).toISOString();

  await supabase.from('cafe24_tokens').upsert({
    id: 1,
    access_token: newTokens.access_token,
    refresh_token: newTokens.refresh_token,
    expires_at: newExpires,
    updated_at: new Date().toISOString(),
  });

  return newTokens.access_token;
}

// 카페24 API GET 헬퍼
async function cafe24Get(accessToken, path) {
  const res = await fetch(
    `https://${MALL_ID}.cafe24api.com/api/v2/admin/${path}`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'X-Cafe24-Api-Version': API_VERSION,
      },
    }
  );
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, ok: res.ok, data: json };
}

// 특정 기간의 정기배송 신청 내역 수집 (페이지네이션)
async function fetchShipmentsForRange(accessToken, startDate, endDate) {
  const results = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const { ok, data } = await cafe24Get(
      accessToken,
      `subscription/shipments?limit=${limit}&offset=${offset}&start_date=${startDate}&end_date=${endDate}`
    );
    if (!ok) break;

    const shipments = data.shipments || [];
    results.push(...shipments);

    if (shipments.length < limit) break;
    offset += limit;
  }

  return results;
}

// 서비스 시작(2020-01-01)부터 오늘까지 연도별로 나눠 전체 수집
async function fetchAllSubscriptionShipments(accessToken) {
  const allShipments = [];
  const today = new Date();
  const serviceStartYear = 2020;

  // 연도별로 최대 1년 단위로 쪼개서 요청
  for (let year = serviceStartYear; year <= today.getFullYear(); year++) {
    const startDate = `${year}-01-01`;
    const rawEnd = new Date(year + 1, 0, 0); // 해당 연도 마지막 날
    const endDate = rawEnd > today
      ? today.toISOString().slice(0, 10)
      : rawEnd.toISOString().slice(0, 10);

    const shipments = await fetchShipmentsForRange(accessToken, startDate, endDate);
    allShipments.push(...shipments);

    // 올해면 더 이상 루프 불필요
    if (year === today.getFullYear()) break;
  }

  return allShipments;
}

export default async function handler(req, res) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    // 1. 토큰 준비
    const accessToken = await getAccessToken(supabase);

    // 2. 전체 기간 정기배송 신청 내역 수집
    const allShipments = await fetchAllSubscriptionShipments(accessToken);

    // 3. subscription_id 기준 중복 제거 후 전화번호 맵 구성
    //    (한 고객이 여러 회차 배송 내역 가질 수 있음)
    const phoneMap = {};
    const cancelledPhones = new Set();

    for (const s of allShipments) {
      const phone = normalizePhone(s.buyer_cellphone || s.receiver_cellphone || '');
      if (!phone) continue;

      const isTerminated = !!s.terminated_date;
      const state = s.subscription_state || '';

      if (isTerminated) {
        cancelledPhones.add(phone);
      }

      if (!phoneMap[phone]) {
        phoneMap[phone] = {
          phone,
          name: s.buyer_name || s.receiver_name || '',
          member_id: s.member_id || '',
          subscription_id: s.subscription_id || '',
          terminated: isTerminated,
          state,
        };
      } else {
        // 해지 안 된 배송 내역이 있으면 활성으로 업데이트
        if (!isTerminated) {
          phoneMap[phone].terminated = false;
        }
      }
    }

    // 해지 여부 최종 정리 (어느 시점에든 활성 내역 있으면 활성)
    for (const phone of Object.keys(phoneMap)) {
      phoneMap[phone].isActive = !cancelledPhones.has(phone) ||
        allShipments.some(s =>
          normalizePhone(s.buyer_cellphone || s.receiver_cellphone || '') === phone &&
          !s.terminated_date
        );
    }

    const allSubscribers = Object.values(phoneMap);
    const activeSubscribers = allSubscribers.filter(s => s.isActive);

    // 4. Supabase 기존 고객 phone 목록
    const { data: existingCustomers, error: custError } = await supabase
      .from('customers')
      .select('phone');
    if (custError) throw new Error(`고객 목록 조회 실패: ${custError.message}`);

    const existingPhones = new Set(
      (existingCustomers || []).map(c => normalizePhone(c.phone))
    );

    // 5. 신규 활성 구독자만 추가
    const newCustomers = [];
    for (const sub of activeSubscribers) {
      if (!sub.phone || existingPhones.has(sub.phone)) continue;

      newCustomers.push({
        name: sub.name,
        phone: sub.phone,
        gender: null,
        cloth_size: null,
        shoe_size: null,
        pay_day: null,
        child_count: 1,
        preference: '없음',
      });
      existingPhones.add(sub.phone);
    }

    let addedCount = 0;
    if (newCustomers.length > 0) {
      const { error: insertError } = await supabase
        .from('customers')
        .insert(newCustomers);
      if (insertError) throw new Error(`신규 고객 추가 실패: ${insertError.message}`);
      addedCount = newCustomers.length;
    }

    // 6. 해지자 목록 (DB에 있는데 해지된 경우)
    const cancelledInDb = allSubscribers
      .filter(s => !s.isActive && existingPhones.has(s.phone))
      .map(s => ({ name: s.name, phone: s.phone }));

    const result = {
      success: true,
      total_shipment_records: allShipments.length,
      unique_subscribers: allSubscribers.length,
      active_subscribers: activeSubscribers.length,
      cancelled_subscribers: allSubscribers.length - activeSubscribers.length,
      new_added: addedCount,
      new_customers: newCustomers.map(c => ({ name: c.name, phone: c.phone })),
      cancelled_in_db: cancelledInDb,
      synced_at: new Date().toISOString(),
    };

    res.status(200).json(result);

  } catch (e) {
    console.error('동기화 오류:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
}
