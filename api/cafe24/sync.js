// 카페24 정기구독 고객 동기화
// - Vercel 크론이 매일 오전 10시(KST) 자동 실행
// - 수동 실행: https://v0-static-html-upload.vercel.app/api/cafe24/sync

import { createClient } from '@supabase/supabase-js';

const MALL_ID = process.env.CAFE24_MALL_ID;

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
  const bufferMs = 5 * 60 * 1000; // 만료 5분 전에 갱신

  if (now < new Date(expiresAt.getTime() - bufferMs)) {
    return data.access_token; // 아직 유효
  }

  // 액세스 토큰 만료 → 리프레시 토큰으로 갱신
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

// 카페24에서 활성 구독 목록 전체 가져오기 (페이지네이션 처리)
async function fetchAllSubscriptions(accessToken) {
  const results = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const res = await fetch(
      `https://${MALL_ID}.cafe24api.com/api/v2/admin/subscriptions?limit=${limit}&offset=${offset}`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'X-Cafe24-Api-Version': '2024-09-01',
        },
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`구독 목록 조회 실패: ${errText}`);
    }

    const data = await res.json();
    const subs = data.subscriptions || [];
    results.push(...subs);

    if (subs.length < limit) break;
    offset += limit;
  }

  return results;
}

export default async function handler(req, res) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    // 1. 토큰 준비
    const accessToken = await getAccessToken(supabase);

    // 2. 카페24 구독 목록 가져오기
    const subscriptions = await fetchAllSubscriptions(accessToken);

    // 활성 구독만 필터 (status: A=Active, I=Inactive, C=Cancel)
    const active = subscriptions.filter(s => s.status === 'A' || s.status === 'active');
    const cancelled = subscriptions.filter(s => s.status === 'C' || s.status === 'cancel');

    // 3. Supabase 기존 고객 목록 가져오기
    const { data: existingCustomers, error: custError } = await supabase
      .from('customers')
      .select('phone');

    if (custError) throw new Error(`고객 목록 조회 실패: ${custError.message}`);

    const existingPhones = new Set(
      (existingCustomers || []).map(c => normalizePhone(c.phone))
    );

    // 4. 신규 구독자 추가
    const newCustomers = [];
    for (const sub of active) {
      const phone = normalizePhone(sub.buyer_phone1 || sub.buyer_phone || '');
      if (!phone || existingPhones.has(phone)) continue;

      newCustomers.push({
        name: sub.buyer_name || '',
        phone,
        gender: null,
        cloth_size: null,
        shoe_size: null,
        pay_day: null,
        child_count: 1,
        preference: '없음',
      });
      existingPhones.add(phone); // 중복 방지
    }

    let addedCount = 0;
    if (newCustomers.length > 0) {
      const { error: insertError } = await supabase
        .from('customers')
        .insert(newCustomers);
      if (insertError) throw new Error(`신규 고객 추가 실패: ${insertError.message}`);
      addedCount = newCustomers.length;
    }

    // 5. 해지자 목록 정리 (삭제는 안 하고 로그만 — 직접 확인 후 처리)
    const cancelledPhones = cancelled
      .map(s => normalizePhone(s.buyer_phone1 || s.buyer_phone || ''))
      .filter(p => p && existingPhones.has(p));

    const result = {
      success: true,
      total_active: active.length,
      new_added: addedCount,
      cancelled_in_db: cancelledPhones.length,
      cancelled_phones: cancelledPhones, // 앱에서 확인 후 직접 삭제
      synced_at: new Date().toISOString(),
    };

    console.log('동기화 완료:', result);
    res.status(200).json(result);

  } catch (e) {
    console.error('동기화 오류:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
}
