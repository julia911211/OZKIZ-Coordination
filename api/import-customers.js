// 로컬스토리지 고객 데이터 → Supabase 마이그레이션용 임시 엔드포인트
// 사용법: 브라우저 콘솔에서 아래 코드 실행
// const d = JSON.parse(localStorage.getItem('ozkids_customers'));
// fetch('/api/import-customers', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}).then(r=>r.json()).then(console.log);

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    const customers = req.body;
    if (!Array.isArray(customers)) {
      return res.status(400).json({ error: '배열 형태로 전송해주세요' });
    }

    // 필드 매핑 (camelCase → snake_case)
    const mapped = customers.map(c => ({
      name: c.name || '',
      phone: (c.phone || '').replace(/[^0-9]/g, ''),
      reg_id: c.regId || c.reg_id || null,
      gender: c.gender || null,
      cloth_size: c.clothSize ?? c.cloth_size ?? null,
      shoe_size: c.shoeSize ?? c.shoe_size ?? null,
      pay_day: c.payDay ?? c.pay_day ?? null,
      child_count: c.childCount ?? c.child_count ?? 1,
      preference: c.preference || '없음',
      zipcode: c.zipcode || null,
      address: c.address || null,
    }));

    // 기존 전체 삭제 후 새로 insert
    const { error: delError } = await supabase
      .from('customers')
      .delete()
      .neq('id', 0); // 전체 삭제
    if (delError) throw new Error(`삭제 실패: ${delError.message}`);

    const { error: insertError } = await supabase
      .from('customers')
      .insert(mapped);
    if (insertError) throw new Error(`삽입 실패: ${insertError.message}`);

    res.status(200).json({ success: true, imported: mapped.length });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}
