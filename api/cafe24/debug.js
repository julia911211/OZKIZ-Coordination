// 카페24 API 탐색용 디버그 엔드포인트
// 접속: https://v0-static-html-upload.vercel.app/api/cafe24/debug

import { createClient } from '@supabase/supabase-js';

const MALL_ID = process.env.CAFE24_MALL_ID;

async function getAccessToken() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data } = await supabase.from('cafe24_tokens').select('*').eq('id', 1).single();
  if (!data) throw new Error('토큰 없음 — /api/cafe24/auth 에서 먼저 인증해주세요');
  return data.access_token;
}

async function tryEndpoint(token, path) {
  try {
    const res = await fetch(`https://${MALL_ID}.cafe24api.com/api/v2/admin/${path}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Cafe24-Api-Version': '2026-03-01',
      },
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, data: json };
  } catch (e) {
    return { status: 'ERROR', data: e.message };
  }
}

export default async function handler(req, res) {
  try {
    const token = await getAccessToken();

    // 최근 30일 날짜 범위
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dateRange = `start_date=${startDate}&end_date=${endDate}`;

    const endpoints = [
      // ✅ subscription/shipments 존재 확인됨 — 날짜 파라미터 추가
      `subscription/shipments?limit=2&${dateRange}`,
      // subscription/ 네임스페이스 탐색
      `subscription/orders?limit=2&${dateRange}`,
      `subscription/products?limit=2`,
      `subscription/customers?limit=2`,
      `subscription/issues?limit=2&${dateRange}`,
      `subscription/recurringorders?limit=2&${dateRange}`,
      `subscription/regularshipments?limit=2&${dateRange}`,
      `subscription/applications?limit=2`,
      `subscription/requests?limit=2`,
      `subscription/members?limit=2`,
      // 날짜 없이도 되는지 확인
      `subscription/shipments?limit=2`,
      `subscription/orders?limit=2`,
    ];

    const results = {};
    for (const ep of endpoints) {
      results[ep] = await tryEndpoint(token, ep);
    }

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
