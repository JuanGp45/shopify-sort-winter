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
    DAYS: 1,
    MIN_SIZES: 4,
    VISIBLE_PRODUCTS: 24,
    NO_ALTERNATE_COLLECTION: 'gid://shopify/Collection/687225241945',
    GIFT_CARD_COLLECTION: 'gid://shopify/Collection/687225209177',
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
  console.log(`   OK ${totalOrders} pedidos, ${Object.keys(salesCount).length} productos`);
  return salesCount;
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
  console.log(`Coleccion "${collectionTitle}" (${products.length} productos)`);
  if (sortOrder !== 'MANUAL') throw new Error(`"${collectionTitle}" debe ser MANUAL`);
  return { products, title: collectionTitle };
}

async function reorderCollection(collectionId, sortedProductIds) {
  const mutation = `mutation ReorderProducts($id: ID!, $moves: [MoveInput!]!) { collectionReorderProducts(id: $id, moves: $moves) { job { id } userErrors { field message } } }`;
  const moves = sortedProductIds.map((productId, index) => ({ id: productId, newPosition: String(index) }));
  const chunkSize = 250;
  for (let i = 0; i < moves.length; i += chunkSize) {
    const chunk = moves.slice(i, i + chunkSize);
    const result = await shopifyGraphQL(mutation, { id: collectionId, moves: chunk });
    if (result.data.collectionReorderProducts.userErrors.length > 0) throw new Error(result.data.collectionReorderProducts.userErrors[0].message);
    if (i + chunkSize < moves.length) await new Promise(r => setTimeout(r, 500));
  }
}

function getProductColor(product) {
  const colorTags = ['BLACK', 'BLUE', 'YELLOW', 'RED', 'GREEN', 'WHITE', 'GREY', 'GRAY', 'PINK', 'ORANGE', 'PURPLE', 'BROWN', 'BEIGE', 'NAVY', 'CREAM', 'KHAKI', 'OLIVE', 'BURGUNDY', 'MAROON', 'TEAL', 'CORAL', 'GOLD', 'SILVER', 'MULTICOLOR'];
  const tags = product.tags || [];
  for (const tag of tags) {
    if (colorTags.includes(tag.toUpperCase())) return tag.toUpperCase();
  }
  return 'UNKNOWN';
}

function getProductGroup(product) {
  const tags = product.tags || [];
  for (const tag of tags) {
    if (tag.startsWith('Group_')) return tag;
  }
  return null;
}

function getProductType(product) {
  const title = product.title.toUpperCase();
  const types = ['HOODIE', 'CREWNECK', 'JEANS', 'PANTS', 'JERSEY', 'JACKET', 'SHIRT', 'TEE', 'SHORTS', 'SWEATER', 'COAT', 'VEST', 'PUFFER', 'CARDIGAN', 'POLO', 'TANK', 'SWEATPANTS', 'JOGGERS', 'TRACKSUIT', 'BLAZER'];
  for (const type of types) {
    if (title.includes(type)) return type;
  }
  return 'OTHER';
}

function isMainType(type) {
  return ['HOODIE', 'CREWNECK'].includes(type);
}

function isGiftCard(product) {
  return product.title.toUpperCase().includes('GIFT CARD');
}

function getAvailableSizes(product) {
  const variants = product.variants?.nodes || [];
  let availableSizes = 0;
  for (const variant of variants) {
    if (variant.inventoryQuantity > 0) {
      const sizeOption = variant.selectedOptions?.find(opt => opt.name.toLowerCase() === 'size' || opt.name.toLowerCase() === 'talla');
      if (sizeOption) availableSizes++;
    }
  }
  return availableSizes;
}

function categorizeProduct(product, sales) {
  const { MIN_SIZES } = getConfig();
  const salesCount = sales[product.id] || 0;
  const totalInventory = product.totalInventory || 0;
  const tracksInventory = product.tracksInventory;
  const color = getProductColor(product);
  const productType = getProductType(product);
  const productGroup = getProductGroup(product);
  const availableSizes = getAvailableSizes(product);
  const isSoldOut = tracksInventory && totalInventory === 0;
  const giftCard = isGiftCard(product);
  const hasEnoughSizes = giftCard || availableSizes >= MIN_SIZES;
  return { ...product, salesCount, isSoldOut, color, productType, productGroup, availableSizes, hasEnoughSizes, totalInventory, isGiftCard: giftCard };
}

function isProductAvailable(product, usedProductIds, usedGroups) {
  if (usedProductIds.has(product.id)) return false;
  if (product.productGroup && usedGroups.has(product.productGroup)) return false;
  return true;
}

function markProductAsUsed(product, usedProductIds, usedGroups) {
  usedProductIds.add(product.id);
  if (product.productGroup) usedGroups.add(product.productGroup);
}

function sortProductsWithRules(products, sales, usedProductIds, usedGroups, shouldAlternate, insertGiftCardAt3) {
  const { MIN_SIZES, VISIBLE_PRODUCTS } = getConfig();
  const categorized = products.map(p => categorizeProduct(p, sales));
  
  const giftCard = categorized.find(p => p.isGiftCard);
  const withoutGiftCard = categorized.filter(p => !p.isGiftCard);
  
  const soldOut = withoutGiftCard.filter(p => p.isSoldOut).sort((a, b) => b.salesCount - a.salesCount);
  const eligible = withoutGiftCard.filter(p => p.hasEnoughSizes && !p.isSoldOut && isProductAvailable(p, usedProductIds, usedGroups)).sort((a, b) => b.salesCount - a.salesCount);
  const notEnoughSizes = withoutGiftCard.filter(p => !p.hasEnoughSizes && !p.isSoldOut).sort((a, b) => b.salesCount - a.salesCount);
  
  console.log(`   Elegibles: ${eligible.length} | Pocas tallas: ${notEnoughSizes.length} | SOLD OUT: ${soldOut.length}`);
  
  let orderedEligible = [];
  
  if (shouldAlternate) {
    const mainProducts = [...eligible.filter(p => isMainType(p.productType))];
    const otherProducts = [...eligible.filter(p => !isMainType(p.productType))];
    
    while (mainProducts.length > 0 || otherProducts.length > 0) {
      for (let i = 0; i < 2 && mainProducts.length > 0; i++) {
        const lastColor = orderedEligible.length > 0 ? orderedEligible[orderedEligible.length - 1].color : null;
        let found = -1;
        for (let j = 0; j < mainProducts.length; j++) {
          if (mainProducts[j].color !== lastColor) { found = j; break; }
        }
        if (found === -1) found = 0;
        orderedEligible.push(mainProducts[found]);
        mainProducts.splice(found, 1);
      }
      if (otherProducts.length > 0) {
        const lastColor = orderedEligible.length > 0 ? orderedEligible[orderedEligible.length - 1].color : null;
        let found = -1;
        for (let j = 0; j < otherProducts.length; j++) {
          if (otherProducts[j].color !== lastColor) { found = j; break; }
        }
        if (found === -1) found = 0;
        orderedEligible.push(otherProducts[found]);
        otherProducts.splice(found, 1);
      }
    }
  } else {
    const remaining = [...eligible];
    while (remaining.length > 0) {
      const lastColor = orderedEligible.length > 0 ? orderedEligible[orderedEligible.length - 1].color : null;
      let foundIndex = remaining.findIndex(p => p.color !== lastColor);
      if (foundIndex === -1) foundIndex = 0;
      orderedEligible.push(remaining[foundIndex]);
      remaining.splice(foundIndex, 1);
    }
  }
  
  if (insertGiftCardAt3 && giftCard) {
    orderedEligible.splice(2, 0, giftCard);
  }
  
  const visibleProducts = orderedEligible.slice(0, VISIBLE_PRODUCTS);
  visibleProducts.forEach(p => markProductAsUsed(p, usedProductIds, usedGroups));
  
  return [...orderedEligible, ...notEnoughSizes, ...soldOut];
}

async function sortCollectionBySales(collectionId, sales, usedProductIds, usedGroups) {
  const { NO_ALTERNATE_COLLECTION, GIFT_CARD_COLLECTION } = getConfig();
  const shouldAlternate = collectionId !== NO_ALTERNATE_COLLECTION;
  const insertGiftCardAt3 = collectionId === GIFT_CARD_COLLECTION;
  
  console.log(`\nProcesando: ${collectionId}`);
  if (shouldAlternate) console.log(`   (alternando: 2 mas vendidos + 1 otro)`);
  if (insertGiftCardAt3) console.log(`   (GIFT CARD en posicion 3)`);
  
  const { products, title } = await getCollectionProducts(collectionId);
  const sorted = sortProductsWithRules(products, sales, usedProductIds, usedGroups, shouldAlternate, insertGiftCardAt3);
  await reorderCollection(collectionId, sorted.map(p => p.id));
  
  console.log(`OK "${title}" ordenada`);
  console.log(`Top 12:`);
  sorted.slice(0, 12).forEach((p, i) => {
    const group = p.productGroup ? ` [${p.productGroup}]` : '';
    console.log(`   ${i + 1}. ${p.title} | ${p.productType} | ${p.color} | ${p.salesCount} ventas${group}`);
  });
  
  return { collectionId, title, total: products.length };
}

async function sortAllCollections() {
  const { DAYS, COLLECTION_IDS, MIN_SIZES, VISIBLE_PRODUCTS } = getConfig();
  console.log('YUXUS WINTER SALE - Ordenacion por ventas');
  console.log(`Ventas ultimo ${DAYS} dia`);
  console.log(`Minimo ${MIN_SIZES} tallas`);
  console.log(`Sin colores consecutivos`);
  console.log(`Sin repetir productos ni grupos (bubbles)`);
  console.log(`Patron: 2 mas vendidos + 1 no hoodie/crewneck`);
  console.log(`Sin repetir en primeros ${VISIBLE_PRODUCTS} de cada coleccion`);
  console.log(`Colecciones: ${COLLECTION_IDS.length}\n`);
  
  const sales = await getSalesFromDays(DAYS);
  const usedProductIds = new Set();
  const usedGroups = new Set();
  const results = [];
  
  for (const id of COLLECTION_IDS) {
    try { results.push(await sortCollectionBySales(id, sales, usedProductIds, usedGroups)); }
    catch (e) { console.error(`Error ${id}:`, e.message); results.push({ collectionId: id, error: e.message }); }
  }
  
  console.log('\nCompletado!');
  console.log(`Productos unicos: ${usedProductIds.size} | Grupos unicos: ${usedGroups.size}`);
  return { success: true, stats: { days: DAYS, minSizes: MIN_SIZES, uniqueProducts: usedProductIds.size, uniqueGroups: usedGroups.size }, results };
}
