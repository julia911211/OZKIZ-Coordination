// 카페24 정기구독 고객 동기화
// - subscription/shipments API 사용 (정기배송 신청 내역)
// - Vercel 크론이 매일 오전 8시(KST) 자동 실행
// - 수동 실행: https://v0-static-html-upload.vercel.app/api/cafe24/sync
//
// 동작 방식:
//   1. 기존 고객(DB에 있는) → 이용중/해지 여부만 체크. 해지면 DB에서 삭제.
//   2. 신규 고객(SYNC_CUTOFF_DATE 이후 신청) → 전체 데이터 가져와서 신규 등록.

import { createClient } from '@supabase/supabase-js';

const MALL_ID = process.env.CAFE24_MALL_ID;
const API_VERSION = '2026-03-01';

// 이 날짜 이후 신청한 고객만 신규 등록 (기존 DB 구축 완료일)
const SYNC_CUTOFF_DATE = '2026-04-20';

// 전화번호 정규화
function normalizePhone(phone) {
  return (phone || '').replace(/[^0-9]/g, '');
}

// option_value_default 파싱: "성별=여아, 의류사이즈=110, 신발사이즈=160"
function parseOptionValue(optionStr) {
  const result = { gender: null, clothSize: null, shoeSize: null };
  if (!optionStr) return result;
  optionStr.split(',').forEach(part => {
    const [k, v] = part.split('=').map(s => s.trim());
    if (!k || !v) return;
    if (k.includes('성별')) result.gender = v;
    else if (k.includes('의류')) result.clothSize = v;
    else if (k.includes('신발')) result.shoeSize = v;
  });
  return result;
}

// 정기결제일: created_date의 일(day) 추출
function extractPayDay(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d.getDate();
}

// Supabase 토큰 조회 + 만료 시 갱신
async function getAccessToken(supabase) {
  const { data, error } = await supabase
    .from('cafe24_tokens')
    .select('*')
    .eq('id', 1)
    .single();

  if (error || !data) throw new Error('저장된 카페24 토큰이 없습니다. /api/cafe24/auth 에서 먼저 인증해주세요.');

  const now = new Date();
  const bufferMs = 5 * 60 * 1000;
  if (now < new Date(new Date(data.expires_at).getTime() - bufferMs)) {
    return data.access_token;
  }

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

// 최근 60일 정기배송 신청 내역 수집 (페이지네이션)
async function fetchRecentShipments(accessToken) {
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

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

export default async function handler(req, res) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    // 1. 토큰 준비
    const accessToken = await getAccessToken(supabase);

    // 2. 최근 60일 신청 내역 수집
    const shipments = await fetchRecentShipments(accessToken);

    // 3. subscription_id 기준으로 구독 상태 집계 (reg_id 매칭용)
    const subStatusMap = {}; // subscription_id → { isActive, createdDate, shipment, phone }
    for (const s of shipments) {
      const subId = s.subscription_id || '';
      if (!subId) continue;
      const isTerminated = !!s.terminated_date;
      const phone = normalizePhone(s.buyer_cellphone || s.receiver_cellphone || '');
      if (!subStatusMap[subId]) {
        subStatusMap[subId] = { isActive: !isTerminated, createdDate: s.created_date || '', shipment: s, phone };
      } else {
        if (!isTerminated) subStatusMap[subId].isActive = true;
      }
    }

    // 4. 기존 DB 고객 조회 (id, reg_id, phone 포함)
    const { data: existingCustomers, error: custError } = await supabase
      .from('customers')
      .select('id, phone, name, reg_id');
    if (custError) throw new Error(`고객 목록 조회 실패: ${custError.message}`);

    // 기존 reg_id 목록 (신규 등록 중복 방지용)
    const existingRegIdSet = new Set(
      (existingCustomers || []).map(c => c.reg_id).filter(Boolean)
    );

    // 5. 기존 고객 중 해지된 고객 삭제
    //    - reg_id가 있는 고객: reg_id로 정확히 매칭 → 해지 시 해당 row만 삭제
    //    - reg_id가 없는 고객 (수동 등록 등): 삭제 대상에서 제외 (안전하게 보존)
    const cancelledDbIds = [];
    const cancelledNames = [];
    for (const c of (existingCustomers || [])) {
      if (!c.reg_id) continue; // reg_id 없으면 건드리지 않음
      const status = subStatusMap[c.reg_id];
      if (status && !status.isActive) {
        cancelledDbIds.push(c.id);
        cancelledNames.push({ name: c.name, phone: normalizePhone(c.phone) });
      }
    }

    let deletedCount = 0;
    if (cancelledDbIds.length > 0) {
      const { error: delError } = await supabase
        .from('customers')
        .delete()
        .in('id', cancelledDbIds);
      if (delError) throw new Error(`해지 고객 삭제 실패: ${delError.message}`);
      deletedCount = cancelledDbIds.length;
    }

    // 6. 신규 고객 등록 (SYNC_CUTOFF_DATE 이후 신청 + DB에 없는 reg_id)
    const newCustomers = [];

    for (const [subId, status] of Object.entries(subStatusMap)) {
      // 이미 DB에 있거나, 해지된 신규는 스킵
      if (existingRegIdSet.has(subId)) continue;
      if (!status.isActive) continue;
      // 컷오프 날짜 이후 신청한 고객만
      if (!status.createdDate || status.createdDate < SYNC_CUTOFF_DATE) continue;

      const s = status.shipment;
      const name = s.buyer_name || s.receiver_name || '';
      const phone = status.phone;

      // 옵션에서 성별/사이즈 추출
      const items = s.items || [];
      let gender = null, clothSize = null, shoeSize = null, totalQty = 0;

      for (const item of items) {
        const opts = parseOptionValue(item.option_value_default || item.option_value || '');
        if (opts.gender && !gender) gender = opts.gender;
        if (opts.clothSize && !clothSize) clothSize = opts.clothSize;
        if (opts.shoeSize && !shoeSize) shoeSize = opts.shoeSize;
        totalQty += parseInt(item.quantity || 1);
      }

      const payDay = extractPayDay(status.createdDate);
      const zipcode = s.receiver_zipcode || s.buyer_zipcode || null;
      const address = [s.receiver_address || s.buyer_address1 || '', s.receiver_address_detail || s.buyer_address2 || ''].filter(Boolean).join(' ') || null;

      newCustomers.push({
        reg_id: subId,
        name,
        phone,
        gender,
        cloth_size: clothSize,
        shoe_size: shoeSize,
        pay_day: payDay,
        child_count: totalQty || 1,
        preference: '없음',
        zipcode,
        address,
        member_id: s.member_id || null,
      });
      existingRegIdSet.add(subId); // 같은 배치에서 중복 방지
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
      shipments_fetched: shipments.length,
      deleted_cancelled: deletedCount,
      cancelled_customers: cancelledNames,
      new_added: addedCount,
      new_customers: newCustomers.map(c => ({
        name: c.name, phone: c.phone, gender: c.gender,
        cloth_size: c.cloth_size, shoe_size: c.shoe_size,
        pay_day: c.pay_day, child_count: c.child_count,
      })),
      synced_at: new Date().toISOString(),
    };

    res.status(200).json(result);

  } catch (e) {
    console.error('동기화 오류:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
}
