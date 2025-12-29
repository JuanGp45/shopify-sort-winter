export default async function handler(request, response) {
  const authHeader = request.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return response.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await sortAllCollections();
    return response.status(200).json(result);
  } catch (error) {
    console.error('Error:', error);
    return response.status(500).json({ error: error.message });
  }
}

function getConfig() {
  return {
    SHOPIFY_STORE: process.env.SHOPIFY_STORE,
    ACCESS_TOKEN: process.env.SHOPIFY_ACCESS_TOKEN,
    DAYS: 2,
    MIN_SIZES: 4,
    VISIBLE_PRODUCTS: 24,
    COLOR_GAP: 1,
    NO_ALTERNATE_COLLECTION: 'gid://shopify/Collection/687225241945',
    GIFT_CARD_COLLECTION: 'gid://shopify/Collection/687225209177',
    SUMMER_COLLECTION: 'gid://shopify/Collection/685894238553',
    COLLECTION_IDS: process.env.COLLECTION_IDS ? process.env.COLLECTION_IDS.split(',').map(id => id.trim()) : [],
  };
}

async function shopifyGraphQL(query, variables = {}) {
  const { SHOPIFY_STORE, ACCESS_TOKEN } = getConfig();
  const response = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': ACCESS_TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json;
}

async function getSalesFromDays(daysAgo) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysAgo);
  const dateFilter = startDate.toISOString().split('T')[0];
  console.log(`Ventas ultimo ${daysAgo} dia (desde ${dateFilter})`);
  const query = `query GetOrders($cursor: String) { orders(first: 250, after: $cursor, query: "created_at:>=${dateFilter} source_name:web financial_status:paid") { pageInfo { hasNextPage endCursor } nodes { id lineItems(first: 100) { nodes { product { id } quantity } } } } }`;
  const salesCount = {};
  let cursor = null, hasNextPage = true, totalOrders = 0;
  while (hasNextPage) {
    const result = await shopifyGraphQL(query, { cursor });
    const orders = result.data.orders;
    for (const order of orders.nodes) {
      totalOrders++;
      for (const item of order.lineItems.nodes) {
        if (item.product?.id) salesCount[item.product.id] = (salesCount[item.product.id] || 0) + item.quantity;
      }
    }
    hasNextPage = orders.pageInfo.hasNextPage;
    cursor = orders.pageInfo.endCursor;
  }
  console.log(`   ${totalOrders} pedidos, ${Object.keys(salesCount).length} productos vendidos`);
  return salesCount;
}

async function getSummerProductIds() {
  const { SUMMER_COLLECTION } = getConfig();
  const query = `query GetCollectionProducts($id: ID!, $cursor: String) { collection(id: $id) { products(first: 250, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id } } } }`;
  const productIds = new Set();
  let cursor = null, hasNextPage = true;
  while (hasNextPage) {
    const result = await shopifyGraphQL(query, { id: SUMMER_COLLECTION, cursor });
    const collection = result.data.collection;
    if (!collection) break;
    collection.products.nodes.forEach(p => productIds.add(p.id));
    hasNextPage = collection.products.pageInfo.hasNextPage;
    cursor = collection.products.pageInfo.endCursor;
  }
  console.log(`Productos verano: ${productIds.size}`);
  return productIds;
}

async function getCollectionProducts(collectionId) {
  const query = `query GetCollectionProducts($id: ID!, $cursor: String) { collection(id: $id) { title sortOrder products(first: 250, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id title tags totalInventory tracksInventory variants(first: 100) { nodes { inventoryQuantity selectedOptions { name value } } } } } } }`;
  const products = [];
  let cursor = null, hasNextPage = true, collectionTitle = '', sortOrder = '';
  while (hasNextPage) {
    const result = await shopifyGraphQL(query, { id: collectionId, cursor });
    const collection = result.data.collection;
    if (!collection) throw new Error(`Coleccion no encontrada: ${collectionId}`);
    collectionTitle = collection.title;
    sortOrder = collection.sortOrder;
    products.push(...collection.products.nodes);
    hasNextPage = collection.products.pageInfo.hasNextPage;
    cursor = collection.products.pageInfo.endCursor;
  }
  console.log(`\n"${collectionTitle}" - ${products.length} productos`);
  if (sortOrder !== 'MANUAL') throw new Error(`"${collectionTitle}" debe ser MANUAL`);
  return { products, title: collectionTitle };
}

function getProductGroup(tags) {
  const groupTag = tags.find(t => t.startsWith('Group_'));
  return groupTag || null;
}

function getProductColor(tags) {
  const colors = ['BLACK', 'BLUE', 'YELLOW', 'RED', 'GREEN', 'WHITE', 'GREY', 'GRAY', 'PINK', 'ORANGE', 'PURPLE', 'BROWN', 'BEIGE', 'NAVY', 'CREAM', 'KHAKI', 'OLIVE', 'BURGUNDY', 'MAROON', 'TEAL', 'CORAL', 'GOLD', 'SILVER'];
  for (const tag of tags) {
    const upper = tag.toUpperCase();
    if (colors.includes(upper)) return upper;
  }
  return null;
}

function getProductType(title) {
  const t = title.toUpperCase();
  if (t.includes('HOODIE')) return 'HOODIE';
  if (t.includes('CREWNECK')) return 'CREWNECK';
  return 'OTHER';
}

function isMainType(type) {
  return type === 'HOODIE' || type === 'CREWNECK';
}

function getAvailableSizes(variants) {
  const validSizes = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
  let count = 0;
  for (const v of variants) {
    if (v.inventoryQuantity > 0) {
      const sizeOpt = v.selectedOptions?.find(o => o.name.toLowerCase() === 'size');
      if (sizeOpt && validSizes.includes(sizeOpt.value.toUpperCase())) count++;
    }
  }
  return count;
}

function getRecentColors(visible, n) {
  const cols = [];
  for (let i = visible.length - 1; i >= 0 && cols.length < n; i--) {
    if (visible[i].color) cols.push(visible[i].color);
  }
  return cols;
}

function sortCollection(products, sales, summerIds, globalUsedIds, globalUsedGroups, shouldAlternate, insertGiftCard) {
  const { MIN_SIZES, VISIBLE_PRODUCTS, COLOR_GAP } = getConfig();
  
  const all = products.map(p => {
    const group = getProductGroup(p.tags);
    const color = getProductColor(p.tags);
    const type = getProductType(p.title);
    const sizes = getAvailableSizes(p.variants?.nodes || []);
    const salesCount = sales[p.id] || 0;
    const isSoldOut = p.tracksInventory && p.totalInventory === 0;
    const isSummer = summerIds.has(p.id);
    const isGiftCard = p.title.toUpperCase().includes('GIFT CARD');
    const hasEnoughSizes = isGiftCard || sizes >= MIN_SIZES;
    return { ...p, group, color, type, sizes, salesCount, isSoldOut, isSummer, isGiftCard, hasEnoughSizes };
  });
  
  const giftCard = all.find(p => p.isGiftCard);
  const eligible = all.filter(p => !p.isGiftCard && !p.isSoldOut && !p.isSummer && p.hasEnoughSizes).sort((a, b) => b.salesCount - a.salesCount);
  const fewSizes = all.filter(p => !p.isGiftCard && !p.isSoldOut && !p.isSummer && !p.hasEnoughSizes).sort((a, b) => b.salesCount - a.salesCount);
  const summer = all.filter(p => !p.isGiftCard && !p.isSoldOut && p.isSummer).sort((a, b) => b.salesCount - a.salesCount);
  const soldOut = all.filter(p => !p.isGiftCard && p.isSoldOut).sort((a, b) => b.salesCount - a.salesCount);
  
  console.log(`   Elegibles: ${eligible.length}, Pocas tallas: ${fewSizes.length}, Verano: ${summer.length}, Sold out: ${soldOut.length}`);
  
  const visible = [];
  const usedGroupsLocal = new Set();
  const usedInVisible = new Set();
  
  function isValid(p) {
    if (globalUsedIds.has(p.id)) return false;
    if (usedInVisible.has(p.id)) return false;
    if (p.group && globalUsedGroups.has(p.group)) return false;
    if (p.group && usedGroupsLocal.has(p.group)) return false;
    return true;
  }
  
  function hasValidColor(p) {
    if (!p.color) return true;
    return !getRecentColors(visible, COLOR_GAP).includes(p.color);
  }
  
  function addProduct(p) {
    visible.push(p);
    usedInVisible.add(p.id);
    if (p.group) usedGroupsLocal.add(p.group);
  }
  
  let patternPos = 0;
  
  while (visible.length < VISIBLE_PRODUCTS) {
    const validAll = eligible.filter(p => isValid(p));
    if (validAll.length === 0) break;
    
    let candidate = null;
    
    if (shouldAlternate) {
      const needMain = patternPos < 2;
      const targetPool = validAll.filter(p => needMain ? isMainType(p.type) : !isMainType(p.type));
      
      candidate = targetPool.find(p => hasValidColor(p));
      if (!candidate) candidate = validAll.find(p => hasValidColor(p));
      if (!candidate) candidate = validAll.find(p => !p.color);
      if (!candidate) candidate = validAll[0];
      
      addProduct(candidate);
      
      if (needMain && isMainType(candidate.type)) {
        patternPos++;
      } else if (!needMain && !isMainType(candidate.type)) {
        patternPos = 0;
      } else {
        patternPos = (patternPos + 1) % 3;
      }
    } else {
      candidate = validAll.find(p => hasValidColor(p));
      if (!candidate) candidate = validAll.find(p => !p.color);
      if (!candidate) candidate = validAll[0];
      addProduct(candidate);
    }
  }
  
  if (insertGiftCard && giftCard && visible.length >= 3) {
    visible.splice(2, 0, giftCard);
  }
  
  for (const p of visible) {
    globalUsedIds.add(p.id);
    if (p.group) globalUsedGroups.add(p.group);
  }
  
  const rest = [...fewSizes, ...summer, ...soldOut].filter(p => !usedInVisible.has(p.id));
  const finalOrder = [...visible, ...eligible.filter(p => !usedInVisible.has(p.id)), ...rest];
  
  return finalOrder.map(p => p.id);
}

async function reorderCollection(collectionId, productIds) {
  const moves = productIds.map((id, index) => ({ id, newPosition: index.toString() }));
  const mutation = `mutation collectionReorderProducts($id: ID!, $moves: [MoveInput!]!) { collectionReorderProducts(id: $id, moves: $moves) { userErrors { field message } } }`;
  
  // Dividir en chunks de 250 max
  const CHUNK_SIZE = 250;
  for (let i = 0; i < moves.length; i += CHUNK_SIZE) {
    const chunk = moves.slice(i, i + CHUNK_SIZE);
    const result = await shopifyGraphQL(mutation, { id: collectionId, moves: chunk });
    if (result.data.collectionReorderProducts.userErrors.length > 0) {
      throw new Error(result.data.collectionReorderProducts.userErrors[0].message);
    }
  }
  console.log(`   Reordenados ${productIds.length} productos`);
}

async function sortAllCollections() {
  const { DAYS, COLLECTION_IDS, MIN_SIZES, VISIBLE_PRODUCTS, COLOR_GAP, NO_ALTERNATE_COLLECTION, GIFT_CARD_COLLECTION } = getConfig();
  
  console.log('=== YUXUS SORT ===');
  console.log(`Ventas: ${DAYS} dia, Min tallas: ${MIN_SIZES}, Visible: ${VISIBLE_PRODUCTS}, Color gap: ${COLOR_GAP}`);
  
  const sales = await getSalesFromDays(DAYS);
  const summerIds = await getSummerProductIds();
  const globalUsedIds = new Set();
  const globalUsedGroups = new Set();
  const results = [];

  for (const collectionId of COLLECTION_IDS) {
    const shouldAlternate = false;
    const insertGiftCard = collectionId === GIFT_CARD_COLLECTION;

    const { products, title } = await getCollectionProducts(collectionId);
    const sortedIds = sortCollection(products, sales, summerIds, globalUsedIds, globalUsedGroups, shouldAlternate, insertGiftCard);
    await reorderCollection(collectionId, sortedIds);

    results.push({ title, total: products.length });
  }

  console.log(`\n=== COMPLETADO ===`);
  console.log(`Productos unicos: ${globalUsedIds.size}, Grupos unicos: ${globalUsedGroups.size}`);

  return { success: true, results };
}
