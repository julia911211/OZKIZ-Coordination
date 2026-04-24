// 특정 회원의 카페24 상품 리뷰 조회
// GET /api/cafe24/fetch-reviews?member_id=3224628831@k

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
  const { member_id, product_no } = req.query;
  if (!member_id) {
    return res.status(400).json({ error: 'member_id 파라미터 필요' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    const token = await getAccessToken(supabase);

    const call = async (path) => {
      const r = await fetch(`https://${MALL_ID}.cafe24api.com/api/v2/admin/${path}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'X-Cafe24-Api-Version': API_VERSION },
      });
      const json = await r.json();
      return { ok: r.ok, status: r.status, json };
    };

    // 1. 후기 게시판 찾기
    const boardsRes = await call('boards?limit=100');
    if (!boardsRes.ok) {
      return res.status(200).json({ reviews: [], debug: `boards API 실패` });
    }

    const boards = boardsRes.json.boards || [];
    const reviewBoards = boards.filter(b => {
      const name = (b.board_name || b.name || '').toLowerCase();
      return name.includes('후기') || name.includes('리뷰') || name.includes('review');
    });

    if (reviewBoards.length === 0) {
      return res.status(200).json({
        reviews: [],
        debug: `후기 게시판 없음. 전체: ${boards.map(b => `[${b.board_no}]${b.board_name||b.name}`).join(' / ')}`
      });
    }

    const targetId = member_id.toLowerCase().trim();
    const allMatched = [];
    const debugInfo = [];

    for (const board of reviewBoards.slice(0, 3)) {
      const boardNo = board.board_no || board.id;
      const boardName = board.board_name || board.name || boardNo;
      const LIMIT = 100;

      // 2. product_no 필터 or 전체 스캔
      const productFilter = product_no ? `&product_no=${product_no}` : '';
      let scanned = 0;
      let offset = 0;

      while (true) {
        const r = await call(`boards/${boardNo}/articles?limit=${LIMIT}&offset=${offset}${productFilter}`);
        if (!r.ok) break;
        const arts = r.json.articles || [];
        scanned += arts.length;
        for (const a of arts) {
          if ((a.member_id || '').toLowerCase().trim() === targetId) {
            allMatched.push(a);
          }
        }
        if (arts.length < LIMIT) break;
        offset += LIMIT;
      }

      debugInfo.push(`[${boardName}] product_no=${product_no||'전체'} / ${scanned}개 스캔 / ${allMatched.length}개 매칭`);
    }

    if (allMatched.length === 0) {
      return res.status(200).json({ reviews: [], debug: debugInfo.join(' | ') });
    }

    // 최신순 정렬
    allMatched.sort((a, b) =>
      new Date(b.created_date || 0) - new Date(a.created_date || 0)
    );

    const result = allMatched.map(a => ({
      review_no: a.article_no || a.id,
      product_name: a.subject || a.title || '',
      rating: a.rating || a.point || 0,
      content: a.content || a.body || '',
      created_date: a.created_date || a.write_date || '',
      images: (a.attach_file_urls || a.images || [])
        .map(img => (typeof img === 'string' ? img : img.image_url || img.thumbnail_url || img.url || ''))
        .filter(Boolean),
    }));

    res.status(200).json({ reviews: result, debug: debugInfo.join(' | ') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
