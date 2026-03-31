import './style.css'
import { inventory as mockInventory, customers as mockCustomers, history as mockHistory } from './mockData.js'
import { coordinate, regenItem, addExtraItem } from './engine.js'
import Papa from 'papaparse'
import { supabase } from './supabase.js'

// IndexedDB Helper for large data (Inventory)
const idbStorage = {
  dbName: 'ozkids_db',
  storeName: 'inventory',
  async open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },
  async get(key) {
    const db = await this.open();
    return new Promise((resolve) => {
      const transaction = db.transaction(this.storeName, 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result || null);
    });
  },
  async set(key, value) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
};

// Persistence helper
const STORAGE_KEYS = {
  INVENTORY: 'ozkids_inventory',
  CUSTOMERS: 'ozkids_customers',
  HISTORY: 'ozkids_history',
  SEASON: 'ozkids_season',
  OVERRIDES: 'ozkids_customer_overrides'
};

function saveToLocal(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    console.warn(`Local Storage Limit Exceeded for ${key}. Use IndexedDB instead.`);
  }
}

function loadFromLocal(key, fallback) {
  const saved = localStorage.getItem(key);
  try {
    return saved ? JSON.parse(saved) : fallback;
  } catch (e) {
    return fallback;
  }
}

// Initial State
let currentInventory = [];
let currentCustomers = loadFromLocal(STORAGE_KEYS.CUSTOMERS, mockCustomers || []);
let currentHistoryMap = loadFromLocal(STORAGE_KEYS.HISTORY, mockHistory || {});
let currentOverrides = loadFromLocal(STORAGE_KEYS.OVERRIDES, {});
let lastCoordResults = [];

function applyOverrides(customers) {
  return customers.map(c => {
    const override = currentOverrides[c.phone];
    if (override) {
      return { ...c, ...override };
    }
    return c;
  });
}

const runBtn = document.querySelector('#run-btn');
const inventoryUpload = document.querySelector('#inventory-upload');
const historyUpload = document.querySelector('#history-upload');
const historyDataUpload = document.querySelector('#history-data-upload');
const resultsContainer = document.querySelector('#results-container');
const totalCustomersEl = document.querySelector('#total-customers');
const totalProductsEl = document.querySelector('#total-products');
const selectedDayStat = document.querySelector('#selected-day-stat');
const selectedDayLabel = document.querySelector('#selected-day-label');
const filteredCountEl = document.querySelector('#filtered-count');
const seasonSelect = document.querySelector('#season-select');
const customerSearch = document.querySelector('#customer-search');
const paydayFilter = document.querySelector('#payday-filter');
const calendarBtn = document.querySelector('#calendar-btn');

async function fetchAllData() {
  console.log('Supabase에서 데이터를 불러오는 중...');
  try {
    // Recursive fetch function to bypass 1000 row limit
    const fetchAllRows = async (table) => {
      let allData = [];
      let from = 0;
      const step = 1000;
      while (true) {
        const { data, error } = await supabase.from(table).select('*').range(from, from + step - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        allData.push(...data);
        if (data.length < step) break;
        from += step;
      }
      return allData;
    };

    const [invData, custData, histData] = await Promise.all([
      fetchAllRows('inventory'),
      fetchAllRows('customers'),
      fetchAllRows('history')
    ]);

    if (invData && invData.length > 0) {
      currentInventory = invData.map(item => ({
        '상품명': item.name,
        '공급처상품명': item.product_code,
        '원가': item.cost,
        '가용재고': item.stock,
        '복종': item.sub_category,
        '복종(대카테고리)': item.big_category,
        '시즌': item.season,
        '이미지URL': item.image_url,
        '옵션': item.product_option
      }));
      console.log(`Inventory loaded: ${currentInventory.length} items`);
    }

    if (custData && custData.length > 0) {
      currentCustomers = custData.map(c => ({
        name: c.name,
        phone: c.phone,
        displayPhone: c.phone,
        regId: c.reg_id,
        gender: c.gender,
        clothSize: c.cloth_size,
        shoeSize: c.shoe_size,
        payDay: c.pay_day,
        childCount: c.child_count,
        preference: c.preference
      }));
    }

    if (histData && histData.length > 0) {
      const map = {};
      histData.forEach(h => {
        if (!map[h.phone]) map[h.phone] = [];
        map[h.phone].push(h.product_name);
      });
      currentHistoryMap = map;
    }
  } catch (err) {
    console.error('Supabase 연동 실패:', err);
  }
}

async function preloadDefaultData() {
  const hasInventory = currentInventory.length > 0;
  if (hasInventory) return;

  console.log('기본 CSV 데이터 로드 중...');
  try {
    const [inv] = await Promise.all([
      fetch('/default/inventory.csv').then(r => r.text())
    ]);
    const inventory = Papa.parse(inv, { header: true }).data;
    // Note: In real scenarios, you might want to auto-upload this to Supabase.
  } catch (e) {
    console.warn('Default CSV loading failed or skipped.');
  }
}

async function initApp() {
  await fetchAllData();
  
  if (currentInventory.length === 0) {
    await preloadDefaultData();
    if (currentInventory.length === 0) currentInventory = mockInventory || [];
  } else {
    console.log(`클라우드 동기화 성공: ${currentInventory.length}개의 상품 정보를 불러왔습니다.`);
  }

  if (currentCustomers.length === 0) currentCustomers = mockCustomers || [];
  if (Object.keys(currentHistoryMap).length === 0) currentHistoryMap = mockHistory || {};

  currentCustomers = currentCustomers.map(c => {
    return {
      name: c.name || '이름없음',
      phone: c.phone,
      displayPhone: c.displayPhone || c.phone,
      regId: c.regId || '-',
      gender: c.gender || '-',
      clothSize: c.clothSize || c.size || '-',
      shoeSize: c.shoeSize || '-',
      payDay: c.payDay || '-',
      childCount: c.name?.includes('★') ? 2 : (c.childCount || 1),
      preference: c.preference || c.memo || '없음'
    };
  });

  const savedSeason = loadFromLocal(STORAGE_KEYS.SEASON, '봄/가을');
  if (seasonSelect) seasonSelect.value = savedSeason;

  currentCustomers = applyOverrides(currentCustomers);
  updateStats();

  const daysHtml = Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${i + 1}일</option>`).join('');
  paydayFilter.insertAdjacentHTML('beforeend', daysHtml);

  if (currentCustomers.length > 0) {
    paydayFilter.value = 'today';
    renderCustomerList(applyMainFilters(currentCustomers), lastCoordResults);
  } else {
    updateStats();
    renderCustomerList(currentCustomers);
  }
}

initApp();

function updateStats() {
  if (totalCustomersEl) totalCustomersEl.textContent = currentCustomers.length;
  if (totalProductsEl) totalProductsEl.textContent = currentInventory.length;

  const filteredCount = applyMainFilters(currentCustomers).length;
  if (filteredCountEl) filteredCountEl.textContent = filteredCount;

  if (paydayFilter) {
    const val = paydayFilter.value;
    if (val === 'all') {
      selectedDayStat.style.display = 'none';
    } else {
      selectedDayStat.style.display = 'flex';
      selectedDayLabel.textContent = val === 'today' ? '오늘 결제 고객' : `${val}일 결제 고객`;
    }
  }
}

const normalizePhone = (p) => p.toString().replace(/[^0-9]/g, '');

seasonSelect.addEventListener('change', () => {
  saveToLocal(STORAGE_KEYS.SEASON, seasonSelect.value);
});

// 1. Customer List Upload
historyUpload.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
    complete: (results) => {
      const data = results.data;
      const newCustomers = [];
      const seenPhones = new Set();

      data.forEach(row => {
        const findValue = (keywords) => {
          const key = Object.keys(row).find(k =>
            keywords.some(kw => k.toLowerCase().includes(kw.toLowerCase()))
          );
          return key ? row[key] : null;
        };

        const rawPhone = (findValue(['휴대전화', '전화번호', '폰번호']) || '').toString().trim();
        const phone = normalizePhone(rawPhone);
        const name = (findValue(['수령인', '고객명', '이름', '성함']) || '').toString().trim();
        const regId = (findValue(['신청번호', '번호', 'No']) || '').toString().trim();
        const rawGender = (findValue(['성별', '구분']) || '-').toString().trim();
        let gender = rawGender.startsWith('여') ? '여아' : (rawGender.startsWith('남') ? '남아' : '-');
        const clothSize = (findValue(['의류사이즈', '의류', '옷사이즈']) || '-').toString().trim();
        const shoeSize = (findValue(['슈즈사이즈', '슈즈', '신발사이즈']) || '-').toString().trim();
        const payDay = (findValue(['정기결제일', '결제일', '납부일']) || '').toString().trim();
        let preference = (findValue(['취향', '메모', '스타일', '비고']) || '').toString().trim();

        if (preference.includes('*')) {
          preference = preference.split('*').map(p => p.trim()).filter(p => p).join('\n* ');
          if (!preference.startsWith('*')) preference = '* ' + preference;
        }

        if (phone && !seenPhones.has(phone)) {
          seenPhones.add(phone);
          newCustomers.push({
            name: name || '이름없음',
            regId: regId || '-',
            displayPhone: rawPhone,
            phone,
            gender,
            clothSize,
            shoeSize,
            payDay: payDay || '-',
            childCount: name.includes('★') ? 2 : 1,
            preference: preference || '없음'
          });
        }
      });

      currentCustomers = applyOverrides(newCustomers);
      
      // Supabase Sync
      const dbData = currentCustomers.map(c => ({
        phone: c.phone,
        name: c.name,
        reg_id: c.regId,
        gender: c.gender,
        cloth_size: c.clothSize,
        shoe_size: c.shoeSize,
        pay_day: c.payDay,
        child_count: c.childCount,
        preference: c.preference
      }));

      supabase.from('customers').upsert(dbData)
        .then(({ error }) => {
          if (error) console.error('고객 DB 동기화 실패:', error);
          else console.log('고객 DB 동기화 완료');
        });

      saveToLocal(STORAGE_KEYS.CUSTOMERS, currentCustomers);
      updateStats();
      paydayFilter.value = 'all';
      renderCustomerList(currentCustomers);
      alert(`${currentCustomers.length}명의 고객 리스트를 불러왔습니다. 클라우드에 동기화되었습니다.`);
    }
  });
});

// 2. Past History Upload
historyDataUpload.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
    complete: (results) => {
      const data = results.data;
      const historyMap = { ...currentHistoryMap };

      data.forEach(row => {
        const findValue = (keywords) => {
          const key = Object.keys(row).find(k =>
            keywords.some(kw => k.toLowerCase().includes(kw.toLowerCase()))
          );
          return key ? row[key] : null;
        };

        const phone = normalizePhone((findValue(['휴대전화', '전화번호', '폰번호']) || '').toString().trim());
        const product = (findValue(['상품명', '제품명', '상품', '품명']) || '').toString().trim();

        if (phone && product) {
          if (!historyMap[phone]) historyMap[phone] = [];
          if (!historyMap[phone].includes(product)) historyMap[phone].push(product);
        }
      });

      currentHistoryMap = historyMap;

      // Supabase Sync (Sync new entries)
      const dbEntries = [];
      Object.keys(historyMap).forEach(phone => {
        historyMap[phone].forEach(product => {
          dbEntries.push({ phone, product_name: product });
        });
      });

      // Simple approach: Clear and re-insert or just upsert?
      // Since it's a prototype, we'll try to upsert based on phone+product if possible, 
      // but the schema doesn't have a unique constraint on phone+product.
      // For now, just insert the new ones or ignore duplicates.
      supabase.from('history').upsert(dbEntries)
        .then(({ error }) => {
          if (error) console.error('이력 DB 동기화 실패:', error);
        });

      saveToLocal(STORAGE_KEYS.HISTORY, currentHistoryMap);
      renderCustomerList(applyMainFilters(currentCustomers), lastCoordResults);
      alert('과거 이력이 연동 및 클라우드 동기화되었습니다.');
    }
  });
});

// 3. Inventory Upload
inventoryUpload.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
    complete: async (results) => {
      console.log('Raw CSV results:', results);

      const mapped = results.data.map((item, idx) => {
  try {
    const keys = Object.keys(item);

    const findExact = (candidates) => {
      const key = keys.find(k => candidates.includes(k.trim()));
      return key ? item[key] : null;
    };

    const findPartial = (candidates) => {
      const key = keys.find(k =>
        candidates.some(kw => k.toLowerCase().includes(kw.toLowerCase()))
      );
      return key ? item[key] : null;
    };

    const name =
      (findExact(['상품명', '제품명', '품명']) ??
       findPartial(['상품명', '제품명', '상품', '품명']) ??
       '').toString().trim();

    const cost =
      findExact(['원가', '공급가', '매입가', '단가']) ??
      findPartial(['원가', '공급가', '매입가', '단가']) ??
      0;

    const stock =
      findExact(['가용재고', '재고', '수량']) ??
      findPartial(['가용재고', '재고', '수량']) ??
      '';

    const subCategory =
  findExact(['복종', '소분류', '복종(소카테고리)', '소카테고리']) ??
  findPartial(['소분류', '복종(소카테고리)', '소카테고리']) ??
  '기타';

const bigCategory =
  findExact(['복종(대카테고리)', '대카테고리', '대분류']) ??
  findPartial(['복종(대카테고리)', '대카테고리', '대분류']) ??
      '기타';

    const season =
      findExact(['시즌', '계절']) ??
      findPartial(['시즌', '계절']) ??
      '사계절';

    const image =
      findExact(['이미지URL', '이미지', 'URL']) ??
      findPartial(['이미지URL', '이미지', 'URL']) ??
      '';

    const option =
      findExact(['옵션', '사이즈', '색상']) ??
      findPartial(['옵션', '사이즈', '색상']) ??
      '';

    const productCode =
      (findExact(['공급처상품명', '상품코드', '바코드', '코드']) ??
       findPartial(['공급처상품명', '상품코드', '바코드', '코드']) ??
       '').toString().trim();

    return {
      '상품명': (item['상품명'] || '').toString().trim(),
      '공급처상품명': (item['공급처상품명'] || '').toString().trim(),
      '원가': parseInt(((item['원가'] || 0).toString()).replace(/[^0-9]/g, '') || 0),
      '가용재고': (item['가용재고'] || '').toString().trim(),
      '복종': (item['복종'] || '기타').toString().trim(),
      '복종(대카테고리)': (item['복종(대카테고리)'] || '기타').toString().trim(),
      '시즌': (item['시즌'] || '사계절').toString().trim(),
      '이미지URL': (item['이미지URL'] || '').toString().trim(),
      '옵션': (item['옵션'] || '').toString().trim()
    };
  } catch (err) {
    console.error(`Error parsing row ${idx}:`, err, item);
    return null;
  }
}).filter(it => it && it['상품명'] !== '');

      if (mapped.length === 0) {
        alert('주의: 불러온 상품이 0개입니다. 엑셀의 "상품명" 컬럼 이름을 확인해 주세요.');
        return;
      }
console.log(
  '업로드 후 카테고리 확인:',
  mapped.slice(0, 20).map(x => ({
    상품명: x['상품명'],
    대분류: x['복종(대카테고리)'],
    소분류: x['복종']
  }))
);
      currentInventory = mapped;

      // Supabase Sync (Chunked Upsert for large inventory)
      // Supabase Sync (Chunked Insert with deep cleaning)
      const dbInv = currentInventory.map(item => ({
        name: (item['상품명'] || '').toString().trim(),
        big_category: (item['복종(대카테고리)'] || '기타').toString().trim(),
        sub_category: (item['복종'] || '기타').toString().trim(),
        cost: parseInt(item['원가']) || 0,
        stock: (item['가용재고'] || '0').toString().trim(),
        season: (item['시즌'] || '사계절').toString().trim(),
        image_url: (item['이미지URL'] || '').toString().trim(),
        product_option: (item['옵션'] || '').toString().trim(),
        product_code: (item['공급처상품명'] || '').toString().trim()
      })).filter(row => row.name !== ''); // Ensure name is never empty

      // Pre-flight Connection Test
      console.log('Testing connection to Supabase...');
      const { error: testError } = await supabase.from('inventory').select('name').limit(1);
      if (testError) {
        alert(`클라우드 연결 테스트 실패! \n현재 네트워크에서 데이터 전송이 차단된 것 같습니다. \n오류: ${testError.message}`);
        return;
      }

      const chunkSize = 200; 
      let syncError = null;

      try {
        // Clear existing inventory first to prevent duplicates
        console.log('Clearing existing cloud inventory...');
        await supabase.from('inventory').delete().neq('id', -1);

        for (let i = 0; i < dbInv.length; i += chunkSize) {
          const chunk = dbInv.slice(i, i + chunkSize);
          const { error } = await supabase.from('inventory').insert(chunk);
          if (error) {
            syncError = error;
            break;
          }
        }

        if (syncError) {
          console.error('재고 DB 동기화 실패:', syncError);
          alert(`재고 데이터 저장 실패: ${syncError.message}`);
        } else {
          console.log('재고 DB 동기화 완료');
          alert(`${dbInv.length}개의 재고 데이터를 성공적으로 클라우드에 동기화했습니다!`);
        }
      } catch (err) {
        console.error('Sync process error:', err);
      }

      await idbStorage.set(STORAGE_KEYS.INVENTORY, currentInventory);
      updateStats();

      console.log('Mapped Inventory (IDB Saved):', currentInventory);
      alert(`${currentInventory.length}개의 재고 데이터를 불러왔습니다. 이제 모든 동료와 공유됩니다!`);

      if (currentCustomers.length > 0) {
        runBtn.click();
      }
    }
  });
});

const getCategoryOptions = (inventory) => {
  const map = {};
  inventory.forEach(item => {
    const big = item['복종(대카테고리)'] || '기타';
    const sub = item['복종'] || '기타';
    if (!map[big]) map[big] = new Set();
    map[big].add(sub);
  });
  return map;
};

function renderCustomerList(customers, resultsMap = null) {
  const catMap = getCategoryOptions(currentInventory);
  const bigCatOptions = Object.keys(catMap)
    .sort((a, b) => a.localeCompare(b, 'ko'))
    .map(k => `<option value="${k}">${k}</option>`)
    .join('');

  resultsContainer.innerHTML = '';
  updateStats();

  if (customers.length === 0) {
    resultsContainer.innerHTML = '<div class="empty-state">조건에 맞는 고객이 없습니다.</div>';
    return;
  }

  customers.forEach(c => {
    const card = document.createElement('div');
    card.className = 'coord-card clickable-card';
    if (c.childCount === 2) card.classList.add('multi-child-card');

    const history = currentHistoryMap[c.phone] || [];
    const findProductImage = (name) => {
      let found = currentInventory.find(inv => inv['상품명'].trim() === name.trim());
      if (found) return found['이미지URL'];
      found = currentInventory.find(inv => name.trim().includes(inv['상품명'].trim()));
      return found ? found['이미지URL'] : null;
    };

    const coordEntry = resultsMap ? resultsMap.find(r => r.customerPhone === c.phone) : null;
    const coordSets = coordEntry ? coordEntry.sets : [];

    let setsHtml = '';
    const childLabels = ['첫째', '둘째'];
    const loopCount = Math.max(c.childCount || 1, coordSets.length);

    for (let sIdx = 0; sIdx < loopCount; sIdx++) {
      const coordResult = coordSets[sIdx];
      let itemsHtml = '';

      if (coordResult && coordResult.items.length > 0) {
        itemsHtml = `<div class="coord-items">` + coordResult.items.map((item, itemIdx) => `
          <div class="item-row" data-phone="${c.phone}" data-set-idx="${sIdx}" data-idx="${itemIdx}">
            <div class="item-thumb"><img src="${item['이미지URL'] || ''}" onerror="this.src='https://placehold.co/100x100?text=No+Img'"></div>
            <div class="item-info">
              <div class="item-cat">${item['복종']}</div>
              <div class="item-name" title="${item['상품명']}">${item['상품명']}</div>
              <div class="item-code" style="font-size:0.6rem; color:var(--text-dim);">${item['공급처상품명'] || ''}</div>
              <div class="item-opt">
                <span>${item['옵션']}</span>
                <span class="stock-info">재고: ${item['가용재고']}</span>
              </div>
              <div class="item-price">${item['원가'].toLocaleString()}원</div>
            </div>
            <button class="item-delete-btn" title="이 항목 삭제">❌</button>
            <button class="item-swap-btn" title="이 항목만 다시 코디">🔄</button>
          </div>
        `).join('');

        if (coordResult.items.length < 7) {
          itemsHtml += `
            <div class="add-item-card" data-phone="${c.phone}" data-set-idx="${sIdx}">
              <button class="add-item-btn" title="상품 추가하기">
                <span class="plus-icon">+</span>
                <span class="add-text">클릭하여 유형 선택</span>
              </button>
              <div class="add-item-form" style="display:none;">
                <select class="form-select big-cat-select">
                  <option value="">대분류 선택</option>
                  ${bigCatOptions}
                </select>
                <select class="form-select sub-cat-select" disabled>
                  <option value="">소분류 선택</option>
                </select>
                <div class="form-actions">
                  <button class="confirm-add-btn">추가</button>
                  <button class="cancel-add-btn">취소</button>
                </div>
              </div>
            </div>
          `;
        }

        itemsHtml += `</div>
        <div class="total-bar">총 ${coordResult.totalCost.toLocaleString()}원 (${coordResult.isValidBudget ? '예산 통과' : '예산 조정 필요'})</div>`;
      } else if (resultsMap) {
        itemsHtml = '<div class="empty-coord">코디 결과가 없습니다.</div>';
      }

      setsHtml += `
        <div class="coord-set-block ${c.childCount > 1 ? 'has-label' : ''}">
          ${c.childCount > 1 ? `<div class="set-label">${childLabels[sIdx] || (sIdx + 1)}번 가이드</div>` : ''}
          ${itemsHtml}
        </div>
      `;
    }

    card.innerHTML = `
      <div class="card-left">
        <div class="card-header">
          <div class="customer-reg-id">${c.regId || '-'}</div>
          <div class="customer-name">
            ${c.name}
            ${c.payDay ? `<div class="payday-badge">매월 ${c.payDay}일 정기결제</div>` : ''}
          </div>
          <div class="customer-id">${c.displayPhone || c.phone}</div>
        </div>
        <div class="customer-info-grid">
          <div class="info-item"><span class="info-label">성별</span><span class="info-value editable-info" contenteditable="true" data-field="gender" data-phone="${c.phone}">${c.gender}</span></div>
          <div class="info-item"><span class="info-label">의류 사이즈</span><span class="info-value editable-info" contenteditable="true" data-field="clothSize" data-phone="${c.phone}">${c.clothSize}</span></div>
          <div class="info-item"><span class="info-label">슈즈 사이즈</span><span class="info-value editable-info" contenteditable="true" data-field="shoeSize" data-phone="${c.phone}">${c.shoeSize}</span></div>
          <div class="info-item full-width"><span class="info-label">취향</span><span class="info-value editable-info" contenteditable="true" data-field="preference" data-phone="${c.phone}">${c.preference || '없음'}</span></div>
        </div>
        <div class="card-actions">
          <button class="save-btn" data-phone="${c.phone}">✅ 코디 확정 (이력 저장)</button>
        </div>
        <div class="card-hint">클릭해서 과거 이력 보기</div>
      </div>
      <div class="card-right">
        ${setsHtml}
      </div>
      <div class="history-section" style="display: none;">
        <h4 class="history-title">과거 이력 (${history.length}개)</h4>
        <div class="history-add-form">
          <input type="text" class="history-add-input" placeholder="직접 구매 상품명 입력...">
          <button class="history-add-btn" data-phone="${c.phone}">추가</button>
        </div>
        <div class="history-list">
          ${[...history].reverse().map(h => {
            const img = findProductImage(h);
            return `
              <div class="history-item">
                <img src="${img || ''}" class="history-thumb" onerror="this.src='https://placehold.co/40x40?text=?'">
                <span class="history-name">${h}</span>
                <button class="history-del-btn" data-phone="${c.phone}" data-val="${h}" title="이력 삭제">×</button>
              </div>
            `;
          }).join('') || '<p style="font-size:0.8rem; color:var(--text-dim);">이력 없음</p>'}
        </div>
      </div>
    `;

    card.querySelectorAll('.item-swap-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const itemRow = btn.closest('.item-row');
        const sIdx = parseInt(itemRow.dataset.setIdx);
        const idx = parseInt(itemRow.dataset.idx);
        const season = seasonSelect.value;
        const entry = lastCoordResults.find(r => r.customerPhone === c.phone);
        if (!entry) return;
        const result = entry.sets[sIdx];
        const newItem = regenItem(c, result.items[idx], result.items, currentInventory, currentHistoryMap, season);
        if (!newItem) return alert('대체할 수 있는 동일 카테고리 상품이 없습니다.');
        result.items[idx] = newItem;
        result.totalCost = result.items.reduce((s, i) => s + (parseInt(i['원가']) || 0), 0);
        result.isValidBudget = result.totalCost >= 43000 && result.totalCost <= 49000;
        renderCustomerList(applyMainFilters(currentCustomers), lastCoordResults);
      });
    });

    card.querySelectorAll('.item-delete-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const itemRow = btn.closest('.item-row');
        const sIdx = parseInt(itemRow.dataset.setIdx);
        const idx = parseInt(itemRow.dataset.idx);
        const entry = lastCoordResults.find(r => r.customerPhone === c.phone);
        if (!entry) return;
        const result = entry.sets[sIdx];

        result.items.splice(idx, 1);
        result.totalCost = result.items.reduce((s, i) => s + (parseInt(i['원가']) || 0), 0);
        result.isValidBudget = result.totalCost >= 43000 && result.totalCost <= 49000;

        renderCustomerList(applyMainFilters(currentCustomers), lastCoordResults);
      });
    });

    card.querySelectorAll('.add-item-card').forEach(addCard => {
      const btn = addCard.querySelector('.add-item-btn');
      const form = addCard.querySelector('.add-item-form');
      const bigSelect = addCard.querySelector('.big-cat-select');
      const subSelect = addCard.querySelector('.sub-cat-select');
      const confirmBtn = addCard.querySelector('.confirm-add-btn');
      const cancelBtn = addCard.querySelector('.cancel-add-btn');
      const sIdx = parseInt(addCard.dataset.setIdx);

      const resetSubSelect = (placeholder = '소분류 선택') => {
        subSelect.innerHTML = `<option value="">${placeholder}</option>`;
        subSelect.value = '';
        subSelect.selectedIndex = 0;
        subSelect.disabled = true;
      };

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        btn.style.display = 'none';
        form.style.display = 'flex';
        bigSelect.value = '';
        resetSubSelect();
      });

      cancelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        form.style.display = 'none';
        btn.style.display = 'flex';
        bigSelect.value = '';
        resetSubSelect();
      });

      bigSelect.addEventListener('change', (e) => {
        e.stopPropagation();
        const selectedBig = e.target.value;

        if (!selectedBig) {
          resetSubSelect();
          return;
        }

        const currentCatMap = getCategoryOptions(currentInventory);
        const subs = Array.from(currentCatMap[selectedBig] || [])
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b, 'ko'));

        subSelect.innerHTML = '';

        const placeholderOption = document.createElement('option');
        placeholderOption.value = '';
        placeholderOption.textContent = '소분류 선택';
        subSelect.appendChild(placeholderOption);

        subs.forEach((s) => {
          const option = document.createElement('option');
          option.value = s;
          option.textContent = s;
          subSelect.appendChild(option);
        });

        subSelect.value = '';
        subSelect.selectedIndex = 0;
        subSelect.disabled = subs.length === 0;
      });

      confirmBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const season = seasonSelect.value;
        const entry = lastCoordResults.find(r => r.customerPhone === c.phone);
        if (!entry) return;
        const result = entry.sets[sIdx];
        if (!result || result.items.length >= 7) return;

        const targetBig = bigSelect.value;
        const targetSub = subSelect.value;

        if (!targetBig) return alert('대분류를 선택해주세요.');
        if (!targetSub) return alert('소분류를 선택해주세요.');

        const newItem = addExtraItem(
          c,
          result.items,
          currentInventory,
          currentHistoryMap,
          season,
          targetBig,
          targetSub
        );

        if (!newItem) {
          return alert('해당 카테고리에 조건(시즌/재고/과거이력)이 맞는 상품이 재고에 없습니다.');
        }

        result.items.push(newItem);
        result.totalCost = result.items.reduce((s, i) => s + (parseInt(i['원가']) || 0), 0);
        result.isValidBudget = result.totalCost >= 43000 && result.totalCost <= 49000;

        renderCustomerList(applyMainFilters(currentCustomers), lastCoordResults);
      });
    });

    card.querySelector('.save-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const entry = lastCoordResults.find(r => r.customerPhone === c.phone);
      if (!entry || entry.sets.length === 0) return alert('먼저 코디를 생성해 주세요.');

      const confirmed = confirm(`${c.name} 고객님의 현재 코디(${entry.sets.length}개 세트)를 확정하고 과거 이력에 추가할까요?`);
      if (confirmed) {
        if (!currentHistoryMap[c.phone]) currentHistoryMap[c.phone] = [];

        entry.sets.forEach(set => {
          set.items.forEach(it => {
            const name = it['상품명'];
            if (!currentHistoryMap[c.phone].includes(name)) {
              currentHistoryMap[c.phone].push(name);
              // Supabase Sync
              supabase.from('history').insert({ phone: c.phone, product_name: name })
                .then(({ error }) => {
                  if (error) console.error('이력 저장 실패:', error);
                });
            }
          });
        });

        saveToLocal(STORAGE_KEYS.HISTORY, currentHistoryMap);
        alert('모든 코디가 확정되어 클라우드에 저장되었습니다.');

        renderCustomerList(applyMainFilters(currentCustomers), lastCoordResults);
      }
    });

    const editables = card.querySelectorAll('.editable-info');
    editables.forEach(el => {
      el.addEventListener('click', (e) => e.stopPropagation());
      el.addEventListener('blur', (e) => {
        const newValue = e.target.innerText.trim();
        const field = e.target.dataset.field;
        const phone = e.target.dataset.phone;

        if (!currentOverrides[phone]) currentOverrides[phone] = {};
        currentOverrides[phone][field] = newValue;
        saveToLocal(STORAGE_KEYS.OVERRIDES, currentOverrides);

        const customer = currentCustomers.find(cu => cu.phone === phone);
        if (customer) {
          customer[field] = newValue;
          saveToLocal(STORAGE_KEYS.CUSTOMERS, currentCustomers);
          
          // Supabase Sync
          const dbFieldMap = {
            gender: 'gender',
            clothSize: 'cloth_size',
            shoeSize: 'shoe_size',
            preference: 'preference'
          };
          
          const dbField = dbFieldMap[field] || field;
          supabase.from('customers').update({ [dbField]: newValue }).eq('phone', phone)
            .then(({ error }) => {
              if (error) console.error('고객 정보 수정 실패:', error);
              else console.log(`Cloud update for ${customer.name}: ${field} -> ${newValue}`);
            });
        }
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          el.blur();
        }
      });
    });

    card.addEventListener('click', () => {
      const section = card.querySelector('.history-section');
      section.style.display = section.style.display === 'block' ? 'none' : 'block';
    });

    const historyAddBtn = card.querySelector('.history-add-btn');
    const historyAddInput = card.querySelector('.history-add-input');

    card.querySelector('.history-section').addEventListener('click', (e) => e.stopPropagation());

    historyAddBtn.addEventListener('click', () => {
      const val = historyAddInput.value.trim();
      if (!val) return;
      if (!currentHistoryMap[c.phone]) currentHistoryMap[c.phone] = [];
      if (!currentHistoryMap[c.phone].includes(val)) {
        currentHistoryMap[c.phone].push(val);
        
        // Supabase Sync
        supabase.from('history').insert({ phone: c.phone, product_name: val })
          .then(({ error }) => {
            if (error) console.error('이력 추가 실패:', error);
          });

        saveToLocal(STORAGE_KEYS.HISTORY, currentHistoryMap);
        updateStats();
        renderCustomerList(applyMainFilters(currentCustomers), lastCoordResults);
        const newCard = resultsContainer.querySelector(`.coord-card [data-phone="${c.phone}"]`)?.closest('.coord-card');
        if (newCard) newCard.querySelector('.history-section').style.display = 'block';
      }
      historyAddInput.value = '';
    });

    historyAddInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') historyAddBtn.click();
    });

    card.querySelectorAll('.history-del-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.dataset.val;
        if (confirm(`'${val}' 이력을 삭제할까요?`)) {
          currentHistoryMap[c.phone] = currentHistoryMap[c.phone].filter(h => h !== val);
          
          // Supabase Sync (Delete specific entry)
          supabase.from('history')
            .delete()
            .match({ phone: c.phone, product_name: val })
            .then(({ error }) => {
              if (error) console.error('이력 삭제 실패:', error);
            });

          saveToLocal(STORAGE_KEYS.HISTORY, currentHistoryMap);
          updateStats();
          renderCustomerList(applyMainFilters(currentCustomers), lastCoordResults);
          const newCard = resultsContainer.querySelector(`.coord-card [data-phone="${c.phone}"]`)?.closest('.coord-card');
          if (newCard) newCard.querySelector('.history-section').style.display = 'block';
        }
      });
    });

    resultsContainer.appendChild(card);
  });
}

function applyMainFilters(customers) {
  const query = customerSearch?.value.toLowerCase().trim() || '';
  const payDay = paydayFilter.value;
  const today = new Date().getDate().toString();

  return customers.filter(c => {
    const nameMatch = c.name.toLowerCase().includes(query);
    const phoneMatch = c.phone.includes(query) || (c.displayPhone && c.displayPhone.includes(query));
    if (!nameMatch && !phoneMatch) return false;

    if (payDay === 'all') return true;

    let targetDay = payDay;
    if (payDay === 'today') targetDay = today;

    const normalize = (d) => d.toString().padStart(2, '0');
    return normalize(c.payDay) === normalize(targetDay);
  });
}

runBtn.addEventListener('click', () => {
  const season = seasonSelect.value;
  lastCoordResults = [];
  currentCustomers.forEach(c => {
    const count = c.childCount || 1;
    const sets = [];
    for (let i = 0; i < count; i++) {
      sets.push(coordinate(c, currentInventory, currentHistoryMap, season));
    }
    lastCoordResults.push({ customerPhone: c.phone, sets });
  });
  renderCustomerList(applyMainFilters(currentCustomers), lastCoordResults);
});

if (currentCustomers.length > 0 && currentInventory.length > 0) {
  setTimeout(() => runBtn.click(), 100);
}

customerSearch.addEventListener('input', () => renderCustomerList(applyMainFilters(currentCustomers), lastCoordResults));
paydayFilter.addEventListener('change', () => renderCustomerList(applyMainFilters(currentCustomers), lastCoordResults));
calendarBtn.addEventListener('click', () => paydayFilter.focus());