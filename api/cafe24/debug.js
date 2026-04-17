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

    const endpoints = [
      'orders?limit=2',
      'orders?limit=2&order_type=subscription',
      'orders?limit=2&order_type=recurring',
      'customers?limit=2',
      'subscriptions?limit=2',
      'billingkeys?limit=2',
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
