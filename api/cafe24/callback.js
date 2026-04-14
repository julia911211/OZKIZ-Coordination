// 카페24 OAuth 콜백 — 인증코드 → 토큰으로 교환 후 Supabase에 저장
import { createClient } from '@supabase/supabase-js';

const MALL_ID = process.env.CAFE24_MALL_ID;
const REDIRECT_URI = 'https://v0-static-html-upload.vercel.app/api/cafe24/callback';

export default async function handler(req, res) {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).send(`카페24 인증 실패: ${error}`);
  }
  if (!code) {
    return res.status(400).send('인증 코드가 없습니다.');
  }

  try {
    // 1. 인증코드 → 액세스 토큰 교환
    const credentials = Buffer.from(
      `${process.env.CAFE24_CLIENT_ID}:${process.env.CAFE24_CLIENT_SECRET}`
    ).toString('base64');

    const tokenRes = await fetch(
      `https://${MALL_ID}.cafe24api.com/api/v2/oauth/token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
        }),
      }
    );

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('토큰 교환 실패:', errText);
      return res.status(500).send(`토큰 교환 실패: ${errText}`);
    }

    const tokens = await tokenRes.json();
    console.log('카페24 토큰 응답:', JSON.stringify(tokens));

    // 2. Supabase에 토큰 저장
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // expires_in(초) 또는 expires_at(날짜문자열) 모두 처리
    let expiresAt;
    if (tokens.expires_in && !isNaN(Number(tokens.expires_in))) {
      expiresAt = new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString();
    } else if (tokens.expires_at) {
      expiresAt = new Date(tokens.expires_at).toISOString();
    } else {
      // 기본값: 2시간 후
      expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    }

    const { error: dbError } = await supabase
      .from('cafe24_tokens')
      .upsert({
        id: 1,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      });

    if (dbError) {
      console.error('토큰 저장 실패:', dbError);
      return res.status(500).send(`토큰 저장 실패: ${dbError.message}`);
    }

    res.status(200).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>✅ 카페24 연동 완료!</h2>
        <p>토큰이 저장되었습니다. 이 창을 닫아도 됩니다.</p>
        <p style="color:#888;font-size:13px">토큰 만료: ${expiresAt}</p>
      </body></html>
    `);
  } catch (e) {
    console.error('콜백 처리 오류:', e);
    res.status(500).send(`오류: ${e.message}`);
  }
}
