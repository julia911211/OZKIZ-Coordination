// 카페24 재고 자동 동기화
// Vercel 크론이 매일 오전 8시(KST) = 23:00 UTC 자동 실행
// 수동 실행: /api/cafe24/sync-inventory

import { createClient } from '@supabase/supabase-js';

const MALL_ID = process.env.CAFE24_MALL_ID;
const API_VERSION = '2026-03-01';
const BATCH_SIZE = 10; // 동시 variant 요청 수
const PARALLEL_UPDATES = 30; // 동시 DB 업데이트 수

async function getAccessToken(supabase) {
  const { data, error } = await supabase
    .from('cafe24_tokens').select('*').eq('id', 1).single();
  if (error || !data) throw new Error('저장된 토큰 없음. /api/cafe24/auth 에서 재인증 필요');

  const now = new Date();
  if (now < new Date(new Date(data.expires_at).getTime() - 5 * 60 * 1000)) {
    return data.access_token;
  }

  const credentials = Buffer.from(
    `${process.env.CAFE24_CLIENT_ID}:${process.env.CAFE24_CLIENT_SECRET}`
  ).toString('base64');

  const refreshRes = await fetch(`https://${MALL_ID}.cafe24api.com/api/v2/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: data.refresh_token }),
  });
  if (!refreshRes.ok) throw new Error('토큰 갱신 실패');

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

async function cafe24Get(path, token) {
  const res = await fetch(`https://${MALL_ID}.cafe24api.com/api/v2/admin/${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-Cafe24-Api-Version': API_VERSION,
    },
  });
  const json = await res.json();
  return { ok: res.ok, status: res.status, json };
}

// 전체 상품 product_no 수집
async function getAllProductNos(token) {
  const productNos = [];
  const LIMIT = 100;
  let offset = 0;
  while (true) {
    const r = await cafe24Get(`products?limit=${LIMIT}&offset=${offset}&fields=product_no`, token);
    if (!r.ok) break;
    const products = r.json.products || [];
    products.forEach(p => productNos.push(p.product_no));
    if (products.length < LIMIT) break;
    offset += LIMIT;
  }
  return productNos;
}

// 상품 variants 조회 → [{barcode, stock}]
async function getVariantsForProduct(productNo, token) {
  const results = [];
  const LIMIT = 100;
  let offset = 0;
  while (true) {
    const r = await cafe24Get(
      `products/${productNo}/variants?limit=${LIMIT}&offset=${offset}&fields=variant_code,quantity`,
      token
    );
    if (!r.ok) break;
    const variants = r.json.variants || [];
    variants.forEach(v => {
      if (v.variant_code) {
        results.push({ barcode: v.variant_code, stock: v.quantity ?? 0 });
      }
    });
    if (variants.length < LIMIT) break;
    offset += LIMIT;
  }
  return results;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    const token = await getAccessToken(supabase);
    const now = new Date().toISOString();

    // 1. 전체 product_no 수집
    const productNos = await getAllProductNos(token);
    console.log(`총 ${productNos.length}개 상품`);

    // 2. variants 배치 조회
    const allVariants = [];
    for (let i = 0; i < productNos.length; i += BATCH_SIZE) {
      const batch = productNos.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(no => getVariantsForProduct(no, token))
      );
      batchResults.forEach(variants => allVariants.push(...variants));
    }
    console.log(`총 ${allVariants.length}개 품목 수집`);

    // 3. 재고 업데이트 (PARALLEL_UPDATES개씩 병렬 update)
    let updated = 0;
    let errors = 0;

    for (let i = 0; i < allVariants.length; i += PARALLEL_UPDATES) {
      const batch = allVariants.slice(i, i + PARALLEL_UPDATES);
      const results = await Promise.all(
        batch.map(async (v) => {
          const { error } = await supabase
            .from('inventory')
            .update({ stock: String(v.stock), stock_updated_at: now })
            .eq('barcode', v.barcode);
          return !error;
        })
      );
      updated += results.filter(Boolean).length;
      errors += results.filter(r => !r).length;
    }

    console.log(`업데이트 완료: ${updated}개, 실패: ${errors}개`);

    return res.status(200).json({
      success: true,
      products: productNos.length,
      variants: allVariants.length,
      updated,
      errors,
      timestamp: now,
    });

  } catch (e) {
    console.error('재고 동기화 실패:', e);
    return res.status(500).json({ error: e.message });
  }
}
