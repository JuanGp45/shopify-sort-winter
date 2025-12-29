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

async function reorderCollection(collectionId, sortedProductIds) {
  const mutation = `mutation ReorderProducts($id: ID!, $moves: [MoveInput!]!) { collectionReorderProducts(id: $id, moves: $moves) { job { id } userErrors { field message } } }`;
  const moves = sortedProductIds.map((productId, index) => ({ id: productId, newPosition: String(index) }));
  const chunkSize = 250;
  for (let i = 0; i < moves.length; i += chunkSize) {
    const chunk = moves.slice(i, i + chunkSize);
    const result = await shopifyGraphQL(mutation, { id: collectionId, moves: chunk });
    if (result.data.collectionReorderProducts.userErrors.length > 0) throw new Error(result.data.collectionReorderProducts.userErrors[0].message);
  }
}

function getProductGroup(tags) {
  for (const tag of tags) {
    if (tag.startsWith('Group_')) return tag;
  }
  return null;
}

function getProductColor(tags) {
  const colors = ['BLACK', 'BLUE', 'YELLOW', 'RED', 'GREEN', 'WHITE', 'GREY', 'GRAY', 'PINK', 'ORANGE', 'PURPLE', 'BROWN', 'BEIGE', 'NAVY', 'CREAM'];
  for (const tag of tags) {
    if (colors.includes(tag.toUpperCase())) return tag.toUpperCase();
  }
  return null;
}

function getProductType(title) {
  const t = title.toUpperCase();
  if (t.includes('HOODIE')) return 'HOODIE';
  if (t.includes('CREWNECK')) return 'CREWNECK';
  if (t.includes('JEANS')) return 'JEANS';
  if (t.includes('PANTS')) return 'PANTS';
  if (t.includes('JERSEY')) return 'JERSEY';
  if (t.includes('LONGSLEEVE')) return 'LONGSLEEVE';
  if (t.includes('SNEAKERS')) return 'SNEAKERS';
  return 'OTHER';
}

function isMainType(type) {
  return type === 'HOODIE' || type === 'CREWNECK';
}

function getAvailableSizes(variants) {
  let count = 0;
  for (const v of variants) {
    if (v.inventoryQuantity > 0) {
      const sizeOpt = v.selectedOptions?.find(o => o.name.toLowerCase() === 'size' || o.name.toLowerCase() === 'talla');
      if (sizeOpt) count++;
    }
  }
  return count;
}

function sortCollection(products, sales, summerIds, globalUsedIds, globalUsedGroups, shouldAlternate, insertGiftCard) {
  const { MIN_SIZES, VISIBLE_PRODUCTS } = getConfig();
  
  // Categorizar todos los productos
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
  
  // Separar gift card
  const giftCard = all.find(p => p.isGiftCard);
  
  // Separar por categorías
  const eligible = all.filter(p => !p.isGiftCard && !p.isSoldOut && !p.isSummer && p.hasEnoughSizes).sort((a, b) => b.salesCount - a.salesCount);
  const fewSizes = all.filter(p => !p.isGiftCard && !p.isSoldOut && !p.isSummer && !p.hasEnoughSizes).sort((a, b) => b.salesCount - a.salesCount);
  const summer = all.filter(p => !p.isGiftCard && !p.isSoldOut && p.isSummer).sort((a, b) => b.salesCount - a.salesCount);
  const soldOut = all.filter(p => !p.isGiftCard && p.isSoldOut).sort((a, b) => b.salesCount - a.salesCount);
  
  console.log(`   Elegibles: ${eligible.length}, Pocas tallas: ${fewSizes.length}, Verano: ${summer.length}, Sold out: ${soldOut.length}`);
  
  // CONSTRUIR LOS 24 VISIBLES - SIN REPETIR GRUPOS
  const visible = [];
  const usedGroupsInThisCollection = new Set();
  
  if (shouldAlternate) {
    // Separar main (hoodie/crewneck) y otros
    const main = eligible.filter(p => isMainType(p.type));
    const other = eligible.filter(p => !isMainType(p.type));
    let mi = 0, oi = 0;
    
    while (visible.length < VISIBLE_PRODUCTS && (mi < main.length || oi < other.length)) {
      // Añadir hasta 2 main
      let addedMain = 0;
      while (addedMain < 2 && mi < main.length && visible.length < VISIBLE_PRODUCTS) {
        const p = main[mi];
        mi++;
        // VERIFICAR: no usado globalmente, no grupo repetido local ni global
        if (globalUsedIds.has(p.id)) continue;
        if (p.group && globalUsedGroups.has(p.group)) continue;
        if (p.group && usedGroupsInThisCollection.has(p.group)) continue;
        // Color consecutivo es menos importante, pero intentamos evitar
        if (visible.length > 0 && p.color && p.color === visible[visible.length - 1].color) {
          // Buscar otro que no sea mismo color
          let found = false;
          for (let j = mi; j < main.length; j++) {
            const alt = main[j];
            if (globalUsedIds.has(alt.id)) continue;
            if (alt.group && globalUsedGroups.has(alt.group)) continue;
            if (alt.group && usedGroupsInThisCollection.has(alt.group)) continue;
            if (alt.color !== p.color) {
              visible.push(alt);
              if (alt.group) usedGroupsInThisCollection.add(alt.group);
              main.splice(j, 1);
              addedMain++;
              found = true;
              break;
            }
          }
          if (!found) {
            visible.push(p);
            if (p.group) usedGroupsInThisCollection.add(p.group);
            addedMain++;
          }
        } else {
          visible.push(p);
          if (p.group) usedGroupsInThisCollection.add(p.group);
          addedMain++;
        }
      }
      
      // Añadir 1 otro
      while (oi < other.length && visible.length < VISIBLE_PRODUCTS) {
        const p = other[oi];
        oi++;
        if (globalUsedIds.has(p.id)) continue;
        if (p.group && globalUsedGroups.has(p.group)) continue;
        if (p.group && usedGroupsInThisCollection.has(p.group)) continue;
        visible.push(p);
        if (p.group) usedGroupsInThisCollection.add(p.group);
        break;
      }
    }
  } else {
    // Sin alternar, solo por ventas
    for (const p of eligible) {
      if (visible.length >= VISIBLE_PRODUCTS) break;
      if (globalUsedIds.has(p.id)) continue;
      if (p.group && globalUsedGroups.has(p.group)) continue;
      if (p.group && usedGroupsInThisCollection.has(p.group)) continue;
      visible.push(p);
      if (p.group) usedGroupsInThisCollection.add(p.group);
    }
  }
  
  // Insertar gift card en posición 3 si aplica
  if (insertGiftCard && giftCard && visible.length >= 2) {
    visible.splice(2, 0, giftCard);
  }
  
  // Marcar como usados globalmente
  for (const p of visible) {
    globalUsedIds.add(p.id);
    if (p.group) globalUsedGroups.add(p.group);
  }
  
  // Log de grupos en visible
  const groupsInVisible = visible.filter(p => p.group).map(p => p.group);
  const uniqueGroups = [...new Set(groupsInVisible)];
  console.log(`   Visible: ${visible.length} productos, ${uniqueGroups.length} grupos unicos`);
  if (groupsInVisible.length !== uniqueGroups.length) {
    console.log(`   ERROR: HAY GRUPOS DUPLICADOS!`);
  }
  
  // Resto de elegibles no usados
  const restEligible = eligible.filter(p => !visible.find(v => v.id === p.id));
  
  // Orden final
  const final = [...visible, ...restEligible, ...fewSizes, ...summer, ...soldOut];
  
  // Log top 10
  console.log(`   Top 10:`);
  final.slice(0, 10).forEach((p, i) => {
    console.log(`      ${i + 1}. ${p.title} ${p.group ? `[${p.group}]` : ''} (${p.salesCount} ventas)`);
  });
  
  return final.map(p => p.id);
}

async function sortAllCollections() {
  const { DAYS, COLLECTION_IDS, VISIBLE_PRODUCTS, NO_ALTERNATE_COLLECTION, GIFT_CARD_COLLECTION } = getConfig();
  
  console.log('=== YUXUS WINTER SALE ===');
  console.log(`Reglas: 1 dia ventas, 4+ tallas, no repetir grupos en ${VISIBLE_PRODUCTS} visibles`);
  
  const sales = await getSalesFromDays(DAYS);
  const summerIds = await getSummerProductIds();
  const globalUsedIds = new Set();
  const globalUsedGroups = new Set();
  const results = [];
  
  for (const collectionId of COLLECTION_IDS) {
    const shouldAlternate = collectionId !== NO_ALTERNATE_COLLECTION;
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
