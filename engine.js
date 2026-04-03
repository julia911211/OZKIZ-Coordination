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
  
  const char12 = code.substring(1, 3);
  const year25 = parseInt(char12);
  
  // Rule: If starts with 25 or higher, it's 2025+
  if (!isNaN(year25) && year25 >= 25 && year25 <= 99) {
    return 2000 + year25;
  }
  
  // Else use the single digit rule
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

  // Weighted probability selection (FIFO biased but full coverage)
  const idx = Math.floor(Math.pow(Math.random(), 2) * finalCandidates.length);
  return finalCandidates[idx];
}

export function coordinate(customer, inventory, historyMap, season = '봄/가을') {
  const customerHistory = historyMap[customer.phone] || [];
  
  // 1. Gender Logic based on '공급처상품명'
  const getProductGender = (item) => {
    const code = (item['공급처상품명'] || '').toString().trim();
    if (!code) return 'U'; // Default to Unisex if no code
    const lastChar = code.charAt(code.length - 1).toUpperCase();
    return ['G', 'B', 'U'].includes(lastChar) ? lastChar : 'U';
  };

  const isGenderCompatible = (item, customerGender) => {
    const pGender = getProductGender(item);
    if (customerGender === '여아') {
      // Girls: G is primary, U is secondary/occasional. B is excluded.
      return pGender === 'G' || pGender === 'U';
    } else if (customerGender === '남아') {
      // Boys: B and U are both compatible. G is excluded.
      return pGender === 'B' || pGender === 'U';
    }
    return true; // Fallback
  };

  // 3. Category Detection
  const getCategory = (item) => {
    const bigCat = (item['복종(대카테고리)'] || '').toString().trim();
    const cat = item['복종'] || '';
    const name = item['상품명'] || '';
    const text = (cat + ' ' + name).toLowerCase();
    
    if (bigCat === '슈즈' || bigCat === '신발' || text.includes('슈즈') || text.includes('운동화') || text.includes('구두') || text.includes('신발') || text.includes('장화') || text.includes('부츠') || text.includes('실내화') || text.includes('샌들') || text.includes('슬리퍼')) return 'shoes';
    
    // Outer sub-categories
    if (text.includes('가디건')) return 'outer-cardigan';
    if (text.includes('조끼') || text.includes('베스트')) return 'outer-vest';
    if (text.includes('점퍼') || text.includes('패딩')) return 'outer-jumper';
    if (text.includes('코트')) return 'outer-coat';
    if (text.includes('자켓')) return 'outer-jacket';
    
    if (text.includes('아우터')) return 'outer';
    
    if (text.includes('상하복') || text.includes('세트') || text.includes('원피스')) return 'set';
    if (text.includes('상의') || text.includes('티셔츠') || text.includes('맨투맨') || text.includes('셔츠')) return 'top';
    if (text.includes('하의') || text.includes('바지') || text.includes('팬츠') || text.includes('치마')) return 'bottom';

    // Accessory / Gift Detection
    if (bigCat === '잡화' || bigCat === '사은품') return 'accessory';

    return 'clothing';
  };

  // 4. Filtering
  const filteredInventory = inventory.filter(item => {
    if (!item['상품명']) return false;

    // Exclude manual-only categories
    const bigCat = (item['복종(대카테고리)'] || '').toString().trim();
    if (['잡화', '사은품', '레인', '부자재'].includes(bigCat)) return false;
    
    // Season check
    const itemSeason = getItemSeason(item);
    if (season !== '사계절' && itemSeason !== '사계절' && itemSeason !== season) return false;

    // History check
    const isAlreadyBought = customerHistory.some(h => {
      const name = item['상품명'].toString().trim();
      return name === h.trim() || h.includes(name) || name.includes(h.trim());
    });
    if (isAlreadyBought) return false;

    // Gender check
    if (!isGenderCompatible(item, customer.gender)) return false;

    // Size check
    if (!isSizeCompatible(item, customer)) return false;

    // Stock check (More Robust)
    let stock = item['가용재고'];
    if (typeof stock === 'string') {
      stock = parseInt(stock.replace(/[^0-9-]/g, ''));
    }
    if (stock !== null && stock !== undefined && !isNaN(stock) && stock <= 0) {
      return false;
    }

    return true;
  });

  // 5. Grouping
  const poolBase = {
    shoes: filteredInventory.filter(i => getCategory(i) === 'shoes'),
    outer: filteredInventory.filter(i => getCategory(i).startsWith('outer')),
    set: filteredInventory.filter(i => getCategory(i) === 'set'),
    top: filteredInventory.filter(i => getCategory(i) === 'top'),
    bottom: filteredInventory.filter(i => getCategory(i) === 'bottom'),
    clothing: filteredInventory.filter(i => getCategory(i) === 'clothing')
  };

  // 6. Selection Logic with Budget Optimization
  const MAX_TRIES = 500;
  let bestAttempt = null;

  for (let t = 0; t < MAX_TRIES; t++) {
    const lastCoordResults = []; // If you need it

    let selected = [];
    let selectedNames = new Set(); // Track selected product names for duplicate prevention
    
    const pool = {
      shoes: [...poolBase.shoes],
      outer: [...poolBase.outer],
      set: [...poolBase.set],
      top: [...poolBase.top],
      bottom: [...poolBase.bottom],
      clothing: [...poolBase.clothing]
    };

    const pickWithPriority = (list) => {
      if (!list || list.length === 0) return null;
      
      // Filter list to items not already selected by name
      const available = list.filter(i => !selectedNames.has((i['상품명'] || '').toString().trim()));
      if (available.length === 0) return null;

      const cGender = customer.gender;
      let picked = null;

      if (cGender === '여아') {
        const girls = available.filter(i => getProductGender(i) === 'G');
        const unisex = available.filter(i => getProductGender(i) === 'U');
        
        // Sort both sub-pools by year
        girls.sort((a, b) => getProductionYear(a) - getProductionYear(b));
        unisex.sort((a, b) => getProductionYear(a) - getProductionYear(b));

        if (girls.length > 0 && (Math.random() < 0.8 || unisex.length === 0)) {
          girls.sort((a, b) => getProductionYear(a) - getProductionYear(b));
          const idx = Math.floor(Math.pow(Math.random(), 2) * girls.length);
          picked = girls[idx];
        } else if (unisex.length > 0) {
          unisex.sort((a, b) => getProductionYear(a) - getProductionYear(b));
          const idx = Math.floor(Math.pow(Math.random(), 2) * unisex.length);
          picked = unisex[idx];
        }
      } 
      
      if (!picked) {
        available.sort((a, b) => getProductionYear(a) - getProductionYear(b));
        const idx = Math.floor(Math.pow(Math.random(), 2) * available.length);
        picked = available[idx];
      }

      // Remove from the source list (not available)
      const idx = list.indexOf(picked);
      if (idx !== -1) list.splice(idx, 1);
      
      // Track name
      selectedNames.add((picked['상품명'] || '').toString().trim());
      
      return picked;
    };

    // Rule: Exactly 1 Shoe
    const shoe = pickWithPriority(pool.shoes);
    if (shoe) selected.push(shoe);

    // Rule: Exactly 1 Outer (Seasonal Priority)
    let outerPool = pool.outer;
    if (season === '봄/가을') {
      // Prioritize cardigans and jackets
      const prioritized = outerPool.filter(i => {
        const cat = getCategory(i);
        return cat === 'outer-cardigan' || cat === 'outer-jacket' || cat === 'outer-vest';
      });
      if (prioritized.length > 0) outerPool = prioritized;
    } else if (season === '겨울') {
      // Prioritize padding and coats
      const prioritized = outerPool.filter(i => {
        const cat = getCategory(i);
        return cat === 'outer-jumper' || cat === 'outer-coat';
      });
      if (prioritized.length > 0) outerPool = prioritized;
    }
    
    const outer = pickWithPriority(outerPool);
    if (outer) {
      outer.isRecommendedOuter = true; // Flag for UI
      selected.push(outer);
      // Remove the selected outer from the main pool to avoid double picking
      const mainIdx = pool.outer.findIndex(i => i['공급처상품명'] === outer['공급처상품명']);
      if (mainIdx !== -1) pool.outer.splice(mainIdx, 1);
    }


    // Rule: Clothing (Set or Top+Bottom)
    const isSet = Math.random() > 0.5 && pool.set.length > 0;
    if (isSet) {
      const set = pickWithPriority(pool.set);
      if (set) selected.push(set);
    } else {
      const top = pickWithPriority(pool.top);
      const bottom = pickWithPriority(pool.bottom);
      if (top) selected.push(top);
      if (bottom) selected.push(bottom);
    }

    // Fill up to 7 items total if budget allows
    const restPool = [...pool.top, ...pool.bottom, ...pool.clothing, ...pool.set];
    while (selected.length < 7 && restPool.length > 0) {
      const extra = pickWithPriority(restPool);
      if (extra) {
        const currentSum = selected.reduce((sum, item) => sum + (parseInt(item['원가']) || 0), 0) + (parseInt(extra['원가']) || 0);
        if (currentSum <= 49000) {
          selected.push(extra);
        } else {
          break;
        }
      } else {
        // No more items can be picked (either pool empty or all remaining are duplicates)
        break;
      }
    }


    const totalCost = selected.reduce((sum, item) => sum + (parseInt(item['원가']) || 0), 0);
    const result = {
      customerPhone: customer.phone,
      customerName: customer.name,
      items: selected,
      totalCost,
      isValidBudget: totalCost >= 43000 && totalCost <= 49000
    };

    if (result.isValidBudget) return result;
    if (!bestAttempt || Math.abs(totalCost - 46000) < Math.abs(bestAttempt.totalCost - 46000)) {
      bestAttempt = result;
    }
  }

  return bestAttempt;
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

  // Weighted probability selection (FIFO biased but full coverage)
  const idx = Math.floor(Math.pow(Math.random(), 2) * finalCandidates.length);
  return finalCandidates[idx];
}
