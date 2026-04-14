// 카페24 OAuth 인증 시작
// 접속: https://v0-static-html-upload.vercel.app/api/cafe24/auth

export default function handler(req, res) {
  const mallId = process.env.CAFE24_MALL_ID;
  const clientId = process.env.CAFE24_CLIENT_ID;
  const redirectUri = 'https://v0-static-html-upload.vercel.app/api/cafe24/callback';

  const scope = [
    'mall.read_member',
    'mall.read_order',
  ].join(',');

  const authUrl =
    `https://${mallId}.cafe24api.com/api/v2/oauth/authorize` +
    `?response_type=code` +
    `&client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scope)}`;

  res.redirect(authUrl);
}
