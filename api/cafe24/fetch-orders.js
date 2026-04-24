// 특정 날짜 범위의 구독 주문 조회 (CSV 생성용)
// GET /api/cafe24/fetch-orders?start_date=2026-04-19&end_date=2026-04-21

import { createClient } from '@supabase/supabase-js';

const MALL_ID = process.env.CAFE24_MALL_ID;
const API_VERSION = '2026-03-01';

async function getAccessToken(supabase) {
  const { data, error } = await supabase
    .from('cafe24_tokens').select('*').eq('id', 1).single();
  if (error || !data) throw new Error('토큰 없음');

  const now = new Date();
  if (now < new Date(new Date(data.expires_at).getTime() - 5 * 60 * 1000)) {
    return data.access_token;
  }

  const credentials = Buffer.from(
    `${process.env.CAFE24_CLIENT_ID}:${process.env.CAFE24_CLIENT_SECRET}`
  ).toString('base64');

  const refreshRes = await fetch(`https://${MALL_ID}.cafe24api.com/api/v2/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${credentials}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: data.refresh_token }),
  });
  if (!refreshRes.ok) throw new Error('토큰 갱신 실패');

  const newTokens = await refreshRes.json();
  const newExpires = new Date(Date.now() + newTokens.expires_in * 1000).toISOString();
  await supabase.from('cafe24_tokens').upsert({
    id: 1, access_token: newTokens.access_token,
    refresh_token: newTokens.refresh_token, expires_at: newExpires,
    updated_at: new Date().toISOString(),
  });
  return newTokens.access_token;
}

export default async function handler(req, res) {
  const { start_date, end_date } = req.query;
  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start_date, end_date 파라미터 필요' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    const token = await getAccessToken(supabase);

    // 구독 주문만 조회 (subscription=T, paid=T, canceled=F)
    const orders = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const url = `https://${MALL_ID}.cafe24api.com/api/v2/admin/orders` +
        `?limit=${limit}&offset=${offset}` +
        `&start_date=${start_date}&end_date=${end_date}` +
        `&subscription=T&paid=T&canceled=F`;

      const r = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'X-Cafe24-Api-Version': API_VERSION },
      });
      const json = await r.json();
      const batch = json.orders || [];
      orders.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
    }

    // 필요한 필드만 추출
    const result = orders.map(o => ({
      order_id: o.order_id,
      subscription_id: o.subscription_id || '',
      member_id: o.member_id || '',
      buyer_name: o.buyer_name || '',
      buyer_cellphone: (o.buyer_cellphone || o.buyer_phone || '').replace(/[^0-9]/g, ''),
      receiver_name: o.receiver_name || o.billing_name || '',
      receiver_cellphone: (o.receiver_cellphone || o.receiver_phone || o.billing_cellphone || '').replace(/[^0-9]/g, ''),
      receiver_zipcode: o.receiver_zipcode || '',
      receiver_address: [o.receiver_address, o.receiver_address_detail].filter(Boolean).join(' '),
    }));

    res.status(200).json({ orders: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
