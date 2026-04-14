export const isSizeCompatible = (item, customer) => {
  const matchesSize = (item, targetSize) => {
    if (!targetSize || targetSize === '-' || targetSize === '자율' || targetSize === 'FREE') return true;
    const itemText = (item['상품명'] + ' ' + (item['옵션'] || '')).toString();
    const target = targetSize.toString().trim();
    const regex = new RegExp(`(^|[^0-9])${target}([^0-9]|$)`);
    return regex.test(itemText) || itemText.includes(target);
  };

  const bigCat = (item['복종(대카테고리)'] || '').toString().trim();
  const subCat = (item['복종'] || '').toString().trim();
  const name = (item['상품명'] || '').toString().trim();
  const text = (bigCat + ' ' + subCat + ' ' + name).toLowerCase();

  // 1. 사은품, 잡화, 우산은 사이즈 무시 (FREE 처리 가능)
  if (bigCat === '사은품' || bigCat === '잡화' || subCat === '잡화' || text.includes('우산')) {
    return true; 
  }

  // 2. 신발 사이즈: 슈즈, 장화, 부츠, 샌들, 슬리퍼 등
  const isShoe = bigCat === '슈즈' || bigCat === '신발' || text.includes('슈즈') || text.includes('운동화') || text.includes('구두') || text.includes('신발') || text.includes('부츠') || text.includes('장화') || text.includes('샌들') || text.includes('슬리퍼');
  if (isShoe) {
    return matchesSize(item, customer.shoeSize);
  }

  // 3. 의류 사이즈: 우비 등 나머지 일반 의류
  return matchesSize(item, customer.clothSize);
};

export const getItemSeason = (item) => {
  let itemSeason = item['시즌']?.toString().trim() || '사계절';
  
  if (itemSeason.includes('봄') || itemSeason.includes('가을')) itemSeason = '봄/가을';
  else if (itemSeason.includes('겨울')) itemSeason = '겨울';
  else if (itemSeason.includes('여름')) itemSeason = '여름';

  if (itemSeason === '사계절' || itemSeason === '') {
    const bigCat = (item['복종(대카테고리)'] || '').toString();
    const subCat = (item['복종'] || '').toString();
    const name = (item['상품명'] || '').toString();
    const opt = (item['옵션'] || '').toString();
    const text = (bigCat + ' ' + subCat + ' ' + name + ' ' + opt).toLowerCase();
    
    if (text.includes('기모') || text.includes('플리스') || text.includes('뽀글이') || text.includes('패딩') || text.includes('방한') || text.includes('수면') || text.includes('목도리') || text.includes('벨벳') || text.includes('코듀로이') || text.includes('융') || text.includes('겨울')) {
      return '겨울';
    }
    if (text.includes('반팔') || text.includes('반바지') || text.includes('나시') || text.includes('민소매') || text.includes('수영복') || text.includes('메쉬') || text.includes('여름')) {
      return '여름';
    }
    if (text.includes('봄') || text.includes('가을') || text.includes('바람막이')) {
      return '봄/가을';
    }
    return '사계절';
  }
  return itemSeason;
};

/**
 * Score an inventory item against a customer's preference text.
 * Returns the number of matched keywords (higher = better match).
 */
const getPreferenceScore = (item, preference) => {
  if (!preference || preference === '없음') return 0;
  // 옵션 컬럼의 색상 앞 콜론 제거 (":베이지,:140" → "베이지 140")
  const optionText = (item['옵션'] || '').toString().replace(/:/g, ' ');
  const itemText = (
    (item['상품명'] || '') + ' ' +
    (item['복종'] || '') + ' ' +
    (item['복종(대카테고리)'] || '') + ' ' +
    optionText
  ).toLowerCase();
  const keywords = preference
    .replace(/[*\n,]/g, ' ')
    .split(/\s+/)
    .filter(k => k.length >= 2);
  return keywords.reduce((score, kw) => score + (itemText.includes(kw.toLowerCase()) ? 1 : 0), 0);
};

/**
 * Replace a single item in the coordination with another from the same category.
 * @param {object} customer - Customer object (for gender/size).
 * @param {object} currentItem - The item to replace.
 * @param {Array} currentItems - All currently selected items (to avoid duplicates).
 * @param {Array} inventory - Full inventory.
 * @param {object} historyMap - Customer history map.
 * @param {string} season - Current season.
 * @returns {object|null} - A new item or null if none available.
 */
const getProductionYear = (item) => {
  const code = (item['공급처상품명'] || '').toString().trim();
  if (code.length < 2) return 2099; // Unknown

  // 2025+ new format: positions 1-2 are both digits AND form a year in [25, currentYear]
  // e.g. O25SF13G → '25' → 2025
  // This disambiguates from old format e.g. O33P18G → '33' > currentYear(26) → old format → 2023
  if (code.length >= 3) {
    const twoDigit = code.substring(1, 3);
    if (/^\d{2}$/.test(twoDigit)) {
      const num = parseInt(twoDigit);
      const currentYearShort = new Date().getFullYear() - 2000;
      if (num >= 25 && num <= currentYearShort) {
        return 2000 + num;
      }
    }
  }

  // Old format (2015-2024): position 1 = last digit of year, position 2 = season code (ignored)
  // e.g. O13F15G → '1' → 2021, O33P18G → '3' → 2023
  const digit = parseInt(code.charAt(1));
  if (isNaN(digit)) return 2099;

  // 5-9: 2015-2019, 0-4: 2020-2024
  if (digit >= 5) return 2010 + digit;
  return 2020 + digit;
};

export function regenItem(customer, currentItem, currentItems, inventory, historyMap, season, rejectedList = []) {
  const getProductGender = (item) => {
    const code = (item['공급처상품명'] || '').toString().trim();
    if (!code) return 'U';
    const lastChar = code.charAt(code.length - 1).toUpperCase();
    return ['G', 'B', 'U'].includes(lastChar) ? lastChar : 'U';
  };

  const isGenderCompatible = (item) => {
    const pGender = getProductGender(item);
    if (customer.gender === '여아') return pGender === 'G' || pGender === 'U';
    if (customer.gender === '남아') return pGender === 'B' || pGender === 'U';
    return true;
  };

  const targetCategory = currentItem['복종'] || '';
  const targetBigCat = currentItem['복종(대카테고리)'] || '';
  const selectedNames = new Set(currentItems.map(i => i['상품명']));
  const customerHistory = historyMap[customer.phone] || [];

  const candidates = inventory.filter(item => {
    if (item['상품명'] === currentItem['상품명']) return false; // exclude same item
    if (selectedNames.has(item['상품명'])) return false; // exclude already selected
    if (!isGenderCompatible(item)) return false;

    // Match same category (복종)
    if (item['복종'] !== targetCategory) return false;
    if (item['복종(대카테고리)'] !== targetBigCat && targetBigCat !== '') return false;

    // History check
    const isAlreadyBought = customerHistory.some(h => {
      const name = item['상품명'].toString().trim();
      return name === h.trim() || h.includes(name) || name.includes(h.trim());
    });
    if (isAlreadyBought) return false;

    // Stock check
    let stock = item['가용재고'];
    if (typeof stock === 'string') stock = parseInt(stock.replace(/[^0-9-]/g, ''));
    if (!isNaN(stock) && stock <= 0) return false;

    // Season check
    const itemSeason = getItemSeason(item);
    if (itemSeason !== '사계절' && itemSeason !== season) return false;

    // Size check
    if (!isSizeCompatible(item, customer)) return false;

    return true;
  });

  if (candidates.length === 0) return null;

  // Filter out session rejections
  let finalCandidates = candidates.filter(item => !rejectedList.includes((item['상품명'] || '').toString().trim()));
  
  // If ALL matching items are rejected, reset by using full candidates
  if (finalCandidates.length === 0 && candidates.length > 0) {
    console.log('Session rejections exhausted. Resetting for this category.');
    finalCandidates = candidates;
  }

  if (finalCandidates.length === 0) return null;

  // Sort oldest first
  finalCandidates.sort((a, b) => getProductionYear(a) - getProductionYear(b));

  // 2023년 이전 제품 우선 사용
  const oldCandidates = finalCandidates.filter(i => getProductionYear(i) < 2023);
  const workPool = oldCandidates.length > 0 ? oldCandidates : finalCandidates;

  // 취향 키워드 소프트 정렬 (하드 필터 아님)
  const pref = (customer.preference || '').replace(/없음/g, '').trim();
  if (pref) {
    workPool.sort((a, b) => getPreferenceScore(b, pref) - getPreferenceScore(a, pref));
  }

  // Weighted probability selection (취향 매칭 + 구형 재고 우선, 가중 랜덤)
  const idx = Math.floor(Math.pow(Math.random(), 2) * workPool.length);
  return workPool[idx];
}

export function coordinate(customer, inventory, historyMap, season = '봄/가을', globalUsed = new Set(), randomize = false) {
  const customerHistory = historyMap[customer.phone] || [];

  // 1. Gender Logic
  const getProductGender = (item) => {
    const code = (item['공급처상품명'] || '').toString().trim();
    if (!code) return 'U';
    const lastChar = code.charAt(code.length - 1).toUpperCase();
    return ['G', 'B', 'U'].includes(lastChar) ? lastChar : 'U';
  };

  const isGenderCompatible = (item, customerGender) => {
    const pGender = getProductGender(item);
    if (customerGender === '여아') return pGender === 'G' || pGender === 'U';
    if (customerGender === '남아') return pGender === 'B' || pGender === 'U';
    return true;
  };

  // 2. Category Detection
  const getCategory = (item) => {
    const bigCat = (item['복종(대카테고리)'] || '').toString().trim();
    const cat = item['복종'] || '';
    const name = item['상품명'] || '';
    const text = (cat + ' ' + name).toLowerCase();

    if (bigCat === '슈즈' || bigCat === '신발' || text.includes('슈즈') || text.includes('운동화') || text.includes('구두') || text.includes('신발') || text.includes('장화') || text.includes('부츠') || text.includes('실내화') || text.includes('샌들') || text.includes('슬리퍼')) return 'shoes';
    if (text.includes('가디건')) return 'outer-cardigan';
    if (text.includes('조끼') || text.includes('베스트')) return 'outer-vest';
    if (text.includes('점퍼') || text.includes('패딩')) return 'outer-jumper';
    if (text.includes('코트')) return 'outer-coat';
    if (text.includes('자켓')) return 'outer-jacket';
    if (text.includes('아우터')) return 'outer';
    if (text.includes('상하복') || text.includes('세트') || text.includes('원피스')) return 'set';
    if (text.includes('상의') || text.includes('티셔츠') || text.includes('맨투맨') || text.includes('셔츠')) return 'top';
    if (text.includes('하의') || text.includes('바지') || text.includes('팬츠') || text.includes('치마')) return 'bottom';
    if (bigCat === '잡화' || bigCat === '사은품') return 'accessory';
    return 'clothing';
  };

  // 3. Filter inventory
  const filteredInventory = inventory.filter(item => {
    if (!item['상품명']) return false;
    const name = (item['상품명'] || '').toString().trim();

    // Exclude globally used items (already assigned to other customers)
    if (globalUsed.has(name)) return false;

    const bigCat = (item['복종(대카테고리)'] || '').toString().trim();
    if (['잡화', '사은품', '레인', '부자재'].includes(bigCat)) return false;

    const itemSeason = getItemSeason(item);
    if (season !== '사계절' && itemSeason !== '사계절' && itemSeason !== season) return false;

    const isAlreadyBought = customerHistory.some(h => {
      return name === h.trim() || h.includes(name) || name.includes(h.trim());
    });
    if (isAlreadyBought) return false;

    if (!isGenderCompatible(item, customer.gender)) return false;
    if (!isSizeCompatible(item, customer)) return false;

    let stock = item['가용재고'];
    if (typeof stock === 'string') stock = parseInt(stock.replace(/[^0-9-]/g, ''));
    if (stock !== null && stock !== undefined && !isNaN(stock) && stock <= 0) return false;

    return true;
  });

  // 4. Sort all by production year (oldest first)
  filteredInventory.sort((a, b) => getProductionYear(a) - getProductionYear(b));

  // 5. Group by category (order preserved = oldest first within each group)
  const poolBase = {
    shoes: filteredInventory.filter(i => getCategory(i) === 'shoes'),
    outer: filteredInventory.filter(i => getCategory(i).startsWith('outer')),
    set: filteredInventory.filter(i => getCategory(i) === 'set'),
    top: filteredInventory.filter(i => getCategory(i) === 'top'),
    bottom: filteredInventory.filter(i => getCategory(i) === 'bottom'),
    clothing: filteredInventory.filter(i => getCategory(i) === 'clothing')
  };

  // 6. Deterministic oldest-first pick (no randomness)
  const buildResult = (useSet) => {
    const usedNames = new Set();

    const pickOldest = (list) => {
      const avail = list.filter(i => !usedNames.has((i['상품명'] || '').toString().trim()));
      if (avail.length === 0) return null;

      const pickFrom = (pool) => {
        if (pool.length === 0) return null;
        // 2023년 이전 제품 우선 사용 (재고 소진 목적)
        const oldPool = pool.filter(i => getProductionYear(i) < 2023);
        const workPool = oldPool.length > 0 ? oldPool : pool;

        // 취향 키워드 소프트 정렬 (하드 필터 아님 — 매칭 없어도 다른 제품 추천 가능)
        const pref = (customer.preference || '').replace(/없음/g, '').trim();
        if (pref) {
          workPool.sort((a, b) => getPreferenceScore(b, pref) - getPreferenceScore(a, pref));
        }

        if (randomize) {
          // 랜덤 재생성: 상위 20% 중 랜덤 선택 (취향 매칭 + 오래된 제품 우선)
          const topN = Math.max(1, Math.ceil(workPool.length * 0.2));
          return workPool[Math.floor(Math.random() * topN)];
        }
        return workPool[0];
      };

      let picked;
      if (customer.gender === '여아') {
        const g = avail.filter(i => getProductGender(i) === 'G');
        picked = pickFrom(g.length > 0 ? g : avail);
      } else if (customer.gender === '남아') {
        const b = avail.filter(i => getProductGender(i) === 'B');
        picked = pickFrom(b.length > 0 ? b : avail);
      } else {
        picked = pickFrom(avail);
      }
      if (!picked) return null;
      usedNames.add((picked['상품명'] || '').toString().trim());
      return picked;
    };

    let selected = [];

    // Shoe
    const shoe = pickOldest(poolBase.shoes);
    if (shoe) selected.push(shoe);

    // Outer (season-prioritized)
    let outerPool = [...poolBase.outer];
    if (season === '봄/가을') {
      const p = outerPool.filter(i => ['outer-cardigan', 'outer-jacket', 'outer-vest'].includes(getCategory(i)));
      if (p.length > 0) outerPool = p;
    } else if (season === '겨울') {
      const p = outerPool.filter(i => ['outer-jumper', 'outer-coat'].includes(getCategory(i)));
      if (p.length > 0) outerPool = p;
    }
    const outer = pickOldest(outerPool);
    if (outer) { outer.isRecommendedOuter = true; selected.push(outer); }

    // Clothing: set or top+bottom
    if (useSet && poolBase.set.length > 0) {
      const set = pickOldest(poolBase.set);
      if (set) selected.push(set);
    } else {
      const top = pickOldest(poolBase.top);
      const bottom = pickOldest(poolBase.bottom);
      if (top) selected.push(top);
      if (bottom) selected.push(bottom);
    }

    // Fill up to 7 items within budget (복종 중복 방지)
    const usedSubCats = new Set(selected.map(i => (i['복종'] || '').toString().trim()));
    const rest = [...poolBase.top, ...poolBase.bottom, ...poolBase.clothing, ...poolBase.set]
      .filter(i => !usedNames.has((i['상품명'] || '').toString().trim()));
    for (const item of rest) {
      if (selected.length >= 7) break;
      const name = (item['상품명'] || '').toString().trim();
      const subCat = (item['복종'] || '').toString().trim();
      if (usedNames.has(name)) continue;
      if (usedSubCats.has(subCat)) continue; // 같은 복종 중복 제외
      const sum = selected.reduce((s, i) => s + (parseInt(i['원가']) || 0), 0) + (parseInt(item['원가']) || 0);
      if (sum <= 49000) {
        selected.push(item);
        usedNames.add(name);
        usedSubCats.add(subCat);
      }
    }

    const totalCost = selected.reduce((s, i) => s + (parseInt(i['원가']) || 0), 0);
    return { items: selected, usedNames, totalCost };
  };

  // Try both paths, pick closer to 46,000원
  const r1 = buildResult(false);
  const r2 = buildResult(true);
  const best = Math.abs(r1.totalCost - 46000) <= Math.abs(r2.totalCost - 46000) ? r1 : r2;

  // Commit selected items to globalUsed so next customers skip them
  best.usedNames.forEach(name => globalUsed.add(name));

  return {
    customerPhone: customer.phone,
    customerName: customer.name,
    items: best.items,
    totalCost: best.totalCost,
    isValidBudget: best.totalCost >= 43000 && best.totalCost <= 49000
  };
}

export function addExtraItem(customer, currentItems, inventory, historyMap, season, targetBigCat = null, targetSubCat = null, rejectedList = []) {
  const getProductGender = (item) => {
    const code = (item['공급처상품명'] || '').toString().trim();
    if (!code) return 'U';
    const lastChar = code.charAt(code.length - 1).toUpperCase();
    return ['G', 'B', 'U'].includes(lastChar) ? lastChar : 'U';
  };

  const isGenderCompatible = (item) => {
    const pGender = getProductGender(item);
    if (customer.gender === '여아') return pGender === 'G' || pGender === 'U';
    if (customer.gender === '남아') return pGender === 'B' || pGender === 'U';
    return true;
  };


  const customerHistory = historyMap[customer.phone] || [];
  const selectedNames = new Set(currentItems.map(i => i['상품명']));

  const candidates = inventory.filter(item => {
    if (selectedNames.has(item['상품명'])) return false;
    if (!isGenderCompatible(item)) return false;

    if (targetBigCat && item['복종(대카테고리)'] !== targetBigCat) return false;
    if (targetSubCat && item['복종'] !== targetSubCat) return false;

    // History check
    const isAlreadyBought = customerHistory.some(h => {
      const name = item['상품명'].toString().trim();
      return name === h.trim() || h.includes(name) || name.includes(h.trim());
    });
    if (isAlreadyBought) return false;

    const itemSeason = getItemSeason(item);
    if (season !== '사계절' && itemSeason !== '사계절' && itemSeason !== season) return false;

    let stock = item['가용재고'];
    if (typeof stock === 'string') stock = parseInt(stock.replace(/[^0-9-]/g, ''));
    if (!isNaN(stock) && stock <= 0) return false;

    if (!isSizeCompatible(item, customer)) return false;

    return true;
  });

  if (candidates.length === 0) return null;

  // Filter out session rejections
  let finalCandidates = candidates.filter(item => !rejectedList.includes((item['상품명'] || '').toString().trim()));
  
  if (finalCandidates.length === 0 && candidates.length > 0) {
    finalCandidates = candidates;
  }

  if (finalCandidates.length === 0) return null;

  // Sort oldest first
  finalCandidates.sort((a, b) => getProductionYear(a) - getProductionYear(b));

  // 2023년 이전 제품 우선 사용
  const oldCandidates2 = finalCandidates.filter(i => getProductionYear(i) < 2023);
  const workPool2 = oldCandidates2.length > 0 ? oldCandidates2 : finalCandidates;

  // 취향 키워드 소프트 정렬 (하드 필터 아님)
  const pref2 = (customer.preference || '').replace(/없음/g, '').trim();
  if (pref2) {
    workPool2.sort((a, b) => getPreferenceScore(b, pref2) - getPreferenceScore(a, pref2));
  }

  // Weighted probability selection (취향 매칭 + 구형 재고 우선, 가중 랜덤)
  const idx = Math.floor(Math.pow(Math.random(), 2) * workPool2.length);
  return workPool2[idx];
}
