// 카페24 정기구독 고객 동기화
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

// 최근 35일 주문 중 subscription:"T" 인 것만 수집 (페이지네이션)
async function fetchSubscriptionOrders(accessToken) {
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const results = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const { ok, data } = await cafe24Get(
      accessToken,
      `orders?limit=${limit}&offset=${offset}&start_date=${startDate}&end_date=${endDate}&paid=T&canceled=F`
    );
    if (!ok) break;

    const orders = data.orders || [];
    // subscription: "T" 인 주문만 필터
    const subOrders = orders.filter(o => o.subscription === 'T');
    results.push(...subOrders);

    if (orders.length < limit) break;
    offset += limit;
  }

  return results;
}

// member_id로 카페24 회원 전화번호 조회
async function fetchMemberPhone(accessToken, memberId) {
  const { ok, data } = await cafe24Get(accessToken, `customers?member_id=${encodeURIComponent(memberId)}`);
  if (!ok || !data.customers || data.customers.length === 0) return null;
  const c = data.customers[0];
  return {
    phone: normalizePhone(c.cellphone || c.phone || ''),
    name: c.name || c.billing_name || '',
  };
}

export default async function handler(req, res) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    // 1. 토큰 준비
    const accessToken = await getAccessToken(supabase);

    // 2. 최근 35일 정기결제 주문 수집
    const subOrders = await fetchSubscriptionOrders(accessToken);

    // member_id 기준 중복 제거 (한 명이 여러 주문 있을 수 있음)
    const memberMap = {};
    for (const o of subOrders) {
      if (o.member_id && !memberMap[o.member_id]) {
        memberMap[o.member_id] = {
          member_id: o.member_id,
          name: o.billing_name || '',
          email: o.member_email || '',
        };
      }
    }
    const uniqueMembers = Object.values(memberMap);

    // 3. Supabase 기존 고객 phone 목록
    const { data: existingCustomers, error: custError } = await supabase
      .from('customers')
      .select('phone');
    if (custError) throw new Error(`고객 목록 조회 실패: ${custError.message}`);

    const existingPhones = new Set(
      (existingCustomers || []).map(c => normalizePhone(c.phone))
    );

    // 4. 신규 구독자 추가
    const newCustomers = [];
    for (const member of uniqueMembers) {
      // 전화번호 조회
      const info = await fetchMemberPhone(accessToken, member.member_id);
      const phone = info?.phone || '';
      const name = info?.name || member.name;

      if (!phone || existingPhones.has(phone)) continue;

      newCustomers.push({
        name,
        phone,
        gender: null,
        cloth_size: null,
        shoe_size: null,
        pay_day: null,
        child_count: 1,
        preference: '없음',
      });
      existingPhones.add(phone);
    }

    let addedCount = 0;
    if (newCustomers.length > 0) {
      const { error: insertError } = await supabase
        .from('customers')
        .insert(newCustomers);
      if (insertError) throw new Error(`신규 고객 추가 실패: ${insertError.message}`);
      addedCount = newCustomers.length;
    }

    const result = {
      success: true,
      subscription_orders_found: subOrders.length,
      unique_subscribers: uniqueMembers.length,
      new_added: addedCount,
      new_customers: newCustomers.map(c => ({ name: c.name, phone: c.phone })),
      synced_at: new Date().toISOString(),
    };

    res.status(200).json(result);

  } catch (e) {
    console.error('동기화 오류:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
}
