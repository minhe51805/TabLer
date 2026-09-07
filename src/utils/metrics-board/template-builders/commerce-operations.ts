import {
  buildPgEntityLabelExpr,
  buildPgLooseEquality,
  buildPgTextExpr,
  findSchemaTable,
  findTableColumn,
  qualifyPgTable,
  quotePgIdentifier,
  withRecruitmentLayout,
} from "../sql-helpers";
import {
  type AIMetricsSchemaTableHint,
  type MetricsTemplateDefinition,
  type MetricsWidgetSeed,
  type MetricsWidgetSeedDraft,
} from "../shared";

export function buildPostgresCommerceOperationsTemplate(
  schemaHints: AIMetricsSchemaTableHint[] | undefined,
): MetricsTemplateDefinition | null {
  if (!schemaHints?.length) return null;

  const users = findSchemaTable(schemaHints, ["users", "user", "accounts"]);
  const sessions = findSchemaTable(schemaHints, ["sessions", "user_sessions"]);
  const identities = findSchemaTable(schemaHints, ["identities", "identity"]);
  const oauthClients = findSchemaTable(schemaHints, ["oauth_clients", "oauth_client"]);
  const orders = findSchemaTable(schemaHints, ["orders", "order"]);
  const orderItems = findSchemaTable(schemaHints, ["order_items", "order_item", "line_items"]);
  const products = findSchemaTable(schemaHints, ["products", "product"]);
  const categories = findSchemaTable(schemaHints, ["categories", "category"]);
  const brands = findSchemaTable(schemaHints, ["brands", "brand"]);
  const reviews = findSchemaTable(schemaHints, ["reviews", "review", "product_reviews"]);
  const messages = findSchemaTable(schemaHints, ["messages", "message"]);
  const auditLogs = findSchemaTable(schemaHints, ["audit_log_entries", "audit_logs", "user_logs", "smart_alerts"]);

  const domainTableCount = [
    users,
    sessions,
    identities,
    oauthClients,
    orders,
    orderItems,
    products,
    categories,
    brands,
    reviews,
    messages,
    auditLogs,
  ].filter(Boolean).length;

  if (domainTableCount < 4 || (!users && !orders && !products)) {
    return null;
  }

  const usersTable = users ? qualifyPgTable(users) : null;
  const sessionsTable = sessions ? qualifyPgTable(sessions) : null;
  const identitiesTable = identities ? qualifyPgTable(identities) : null;
  const oauthClientsTable = oauthClients ? qualifyPgTable(oauthClients) : null;
  const ordersTable = orders ? qualifyPgTable(orders) : null;
  const orderItemsTable = orderItems ? qualifyPgTable(orderItems) : null;
  const productsTable = products ? qualifyPgTable(products) : null;
  const categoriesTable = categories ? qualifyPgTable(categories) : null;
  const brandsTable = brands ? qualifyPgTable(brands) : null;
  const reviewsTable = reviews ? qualifyPgTable(reviews) : null;
  const messagesTable = messages ? qualifyPgTable(messages) : null;
  const auditLogsTable = auditLogs ? qualifyPgTable(auditLogs) : null;

  const userIdColumn = findTableColumn(users, ["id"]);
  const userCreatedAtColumn = findTableColumn(users, ["created_at", "created_on", "registered_at"]);
  const userEmailColumn = findTableColumn(users, ["email", "email_address", "username", "name"]);

  const identityIdColumn = findTableColumn(identities, ["id"]);
  const identityProviderColumn = findTableColumn(identities, ["provider", "provider_name", "type"]);

  const orderCreatedAtColumn = findTableColumn(orders, ["created_at", "created_on", "ordered_at", "placed_at"]);
  const orderStatusColumn = findTableColumn(orders, ["status", "order_status", "payment_status"]);
  const orderUserIdColumn = findTableColumn(orders, ["user_id", "customer_id", "account_id"]);

  const orderItemProductIdColumn = findTableColumn(orderItems, ["product_id", "item_id"]);
  const orderItemQuantityColumn = findTableColumn(orderItems, ["quantity", "qty", "count"]);

  const productIdColumn = findTableColumn(products, ["id"]);
  const productTitleColumn = findTableColumn(products, ["name", "title", "product_name", "label"]);
  const productCategoryIdColumn = findTableColumn(products, ["category_id"]);
  const productBrandIdColumn = findTableColumn(products, ["brand_id"]);
  const productCreatedAtColumn = findTableColumn(products, ["created_at", "created_on", "published_at"]);

  const categoryIdColumn = findTableColumn(categories, ["id"]);
  const categoryNameColumn = findTableColumn(categories, ["name", "title", "label", "category_name"]);

  const brandIdColumn = findTableColumn(brands, ["id"]);
  const brandNameColumn = findTableColumn(brands, ["name", "title", "label", "brand_name"]);

  const reviewProductIdColumn = findTableColumn(reviews, ["product_id", "item_id"]);
  const reviewScoreColumn = findTableColumn(reviews, ["rating", "score", "stars"]);

  const messageCreatedAtColumn = findTableColumn(messages, ["created_at", "created_on", "sent_at"]);
  const messageStatusColumn = findTableColumn(messages, ["status", "message_status", "state"]);

  const auditCreatedAtColumn = findTableColumn(auditLogs, ["created_at", "created_on", "logged_at"]);
  const auditActionColumn = findTableColumn(auditLogs, ["action", "event", "event_type", "type"]);

  const userLabelExpr = buildPgEntityLabelExpr({
    alias: "u",
    titleColumn: userEmailColumn,
    idColumn: userIdColumn,
    fallbackPrefix: "User",
  });
  const productLabelExpr = buildPgEntityLabelExpr({
    alias: "p",
    titleColumn: productTitleColumn,
    idColumn: productIdColumn,
    fallbackPrefix: "Product",
  });

  const seeds: MetricsWidgetSeed[] = [];
  const pushSeed = (seed: MetricsWidgetSeedDraft | null) => {
    if (!seed) return;
    seeds.push(withRecruitmentLayout(seeds.length, seed));
  };

  if (usersTable) {
    pushSeed({
      type: "scoreboard",
      title: "Total Users",
      query: [
        "SELECT",
        "  COUNT(*)::bigint AS total_users,",
        "  'users' AS label",
        `FROM ${usersTable} u;`,
      ].join("\n"),
    });
  }

  if (ordersTable) {
    pushSeed({
      type: "scoreboard",
      title: "Total Orders",
      query: [
        "SELECT",
        "  COUNT(*)::bigint AS total_orders,",
        "  'orders' AS label",
        `FROM ${ordersTable} o;`,
      ].join("\n"),
    });
  }

  if (productsTable) {
    pushSeed({
      type: "scoreboard",
      title: "Total Products",
      query: [
        "SELECT",
        "  COUNT(*)::bigint AS total_products,",
        "  'products' AS label",
        `FROM ${productsTable} p;`,
      ].join("\n"),
    });
  }

  if (sessionsTable) {
    pushSeed({
      type: "scoreboard",
      title: "Active Sessions",
      query: [
        "SELECT",
        "  COUNT(*)::bigint AS total_sessions,",
        "  'sessions' AS label",
        `FROM ${sessionsTable} s;`,
      ].join("\n"),
    });
  } else if (oauthClientsTable) {
    pushSeed({
      type: "scoreboard",
      title: "OAuth Clients",
      query: [
        "SELECT",
        "  COUNT(*)::bigint AS total_oauth_clients,",
        "  'oauth clients' AS label",
        `FROM ${oauthClientsTable} oc;`,
      ].join("\n"),
    });
  }

  if (ordersTable && orderStatusColumn) {
    pushSeed({
      type: "bar",
      title: "Orders by Status",
      query: [
        "SELECT",
        `  ${buildPgTextExpr("o", orderStatusColumn, "Unknown status")} AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${ordersTable} o`,
        "GROUP BY 1",
        "ORDER BY value DESC, label ASC",
        "LIMIT 10;",
      ].join("\n"),
    });
  }

  if (ordersTable && orderCreatedAtColumn) {
    pushSeed({
      type: "line",
      title: "Orders by Month",
      query: [
        "SELECT",
        `  TO_CHAR(DATE_TRUNC('month', o.${quotePgIdentifier(orderCreatedAtColumn)}), 'YYYY-MM') AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${ordersTable} o`,
        `WHERE o.${quotePgIdentifier(orderCreatedAtColumn)} IS NOT NULL`,
        "GROUP BY 1",
        "ORDER BY 1;",
      ].join("\n"),
    });
  }

  if (
    productsTable &&
    orderItemsTable &&
    productIdColumn &&
    orderItemProductIdColumn
  ) {
    const quantityExpr = orderItemQuantityColumn
      ? `COALESCE(SUM(oi.${quotePgIdentifier(orderItemQuantityColumn)})::bigint, 0)`
      : "COUNT(*)::bigint";

    pushSeed({
      type: "bar",
      title: "Top Products by Ordered Qty",
      query: [
        "SELECT",
        `  ${productLabelExpr} AS label,`,
        `  ${quantityExpr} AS value`,
        `FROM ${orderItemsTable} oi`,
        `LEFT JOIN ${productsTable} p ON ${buildPgLooseEquality("p", productIdColumn, "oi", orderItemProductIdColumn)}`,
        "GROUP BY 1",
        "ORDER BY value DESC, label ASC",
        "LIMIT 10;",
      ].join("\n"),
    });
  }

  if (
    productsTable &&
    categoriesTable &&
    productCategoryIdColumn &&
    categoryIdColumn &&
    categoryNameColumn
  ) {
    pushSeed({
      type: "pie",
      title: "Products by Category",
      query: [
        "SELECT",
        `  ${buildPgTextExpr("c", categoryNameColumn, "Unknown category")} AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${productsTable} p`,
        `LEFT JOIN ${categoriesTable} c ON ${buildPgLooseEquality("c", categoryIdColumn, "p", productCategoryIdColumn)}`,
        "GROUP BY 1",
        "ORDER BY value DESC, label ASC",
        "LIMIT 8;",
      ].join("\n"),
    });
  }

  if (
    productsTable &&
    brandsTable &&
    productBrandIdColumn &&
    brandIdColumn &&
    brandNameColumn
  ) {
    pushSeed({
      type: "pie",
      title: "Products by Brand",
      query: [
        "SELECT",
        `  ${buildPgTextExpr("b", brandNameColumn, "Unknown brand")} AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${productsTable} p`,
        `LEFT JOIN ${brandsTable} b ON ${buildPgLooseEquality("b", brandIdColumn, "p", productBrandIdColumn)}`,
        "GROUP BY 1",
        "ORDER BY value DESC, label ASC",
        "LIMIT 8;",
      ].join("\n"),
    });
  }

  if (usersTable && userCreatedAtColumn) {
    pushSeed({
      type: "line",
      title: "New Users by Month",
      query: [
        "SELECT",
        `  TO_CHAR(DATE_TRUNC('month', u.${quotePgIdentifier(userCreatedAtColumn)}), 'YYYY-MM') AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${usersTable} u`,
        `WHERE u.${quotePgIdentifier(userCreatedAtColumn)} IS NOT NULL`,
        "GROUP BY 1",
        "ORDER BY 1;",
      ].join("\n"),
    });
  }

  if (
    ordersTable &&
    usersTable &&
    orderUserIdColumn &&
    userIdColumn
  ) {
    pushSeed({
      type: "table",
      title: "Top Users by Orders",
      query: [
        "SELECT",
        `  ${userLabelExpr} AS user_account,`,
        "  COUNT(*)::bigint AS orders",
        `FROM ${ordersTable} o`,
        `LEFT JOIN ${usersTable} u ON ${buildPgLooseEquality("u", userIdColumn, "o", orderUserIdColumn)}`,
        "GROUP BY 1",
        "ORDER BY orders DESC, user_account ASC",
        "LIMIT 10;",
      ].join("\n"),
    });
  }

  if (
    reviewsTable &&
    productsTable &&
    reviewProductIdColumn &&
    productIdColumn
  ) {
    const reviewCountExpr = `COUNT(r.${quotePgIdentifier(reviewProductIdColumn)})::bigint`;
    const reviewValueExpr = reviewScoreColumn
      ? `COALESCE(ROUND(AVG(r.${quotePgIdentifier(reviewScoreColumn)}::numeric), 2), 0)`
      : reviewCountExpr;

    pushSeed({
      type: "bar",
      title: reviewScoreColumn ? "Average Rating by Product" : "Reviews by Product",
      query: [
        "SELECT",
        `  ${productLabelExpr} AS label,`,
        `  ${reviewValueExpr} AS value`,
        `FROM ${productsTable} p`,
        `LEFT JOIN ${reviewsTable} r ON ${buildPgLooseEquality("p", productIdColumn, "r", reviewProductIdColumn)}`,
        `WHERE p.${quotePgIdentifier(productIdColumn)} IS NOT NULL`,
        "GROUP BY 1",
        "ORDER BY value DESC, label ASC",
        "LIMIT 10;",
      ].join("\n"),
    });
  }

  if (messagesTable && messageCreatedAtColumn) {
    pushSeed({
      type: "line",
      title: "Messages by Day",
      query: [
        "SELECT",
        `  TO_CHAR(DATE_TRUNC('day', m.${quotePgIdentifier(messageCreatedAtColumn)}), 'YYYY-MM-DD') AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${messagesTable} m`,
        `WHERE m.${quotePgIdentifier(messageCreatedAtColumn)} IS NOT NULL`,
        "GROUP BY 1",
        "ORDER BY 1 DESC",
        "LIMIT 14;",
      ].join("\n"),
    });
  } else if (messagesTable && messageStatusColumn) {
    pushSeed({
      type: "bar",
      title: "Messages by Status",
      query: [
        "SELECT",
        `  ${buildPgTextExpr("m", messageStatusColumn, "Unknown status")} AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${messagesTable} m`,
        "GROUP BY 1",
        "ORDER BY value DESC, label ASC",
        "LIMIT 10;",
      ].join("\n"),
    });
  }

  if (auditLogsTable && auditCreatedAtColumn) {
    pushSeed({
      type: "line",
      title: "Audit Events by Day",
      query: [
        "SELECT",
        `  TO_CHAR(DATE_TRUNC('day', a.${quotePgIdentifier(auditCreatedAtColumn)}), 'YYYY-MM-DD') AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${auditLogsTable} a`,
        `WHERE a.${quotePgIdentifier(auditCreatedAtColumn)} IS NOT NULL`,
        "GROUP BY 1",
        "ORDER BY 1 DESC",
        "LIMIT 14;",
      ].join("\n"),
    });
  } else if (auditLogsTable && auditActionColumn) {
    pushSeed({
      type: "bar",
      title: "Audit Events by Type",
      query: [
        "SELECT",
        `  ${buildPgTextExpr("a", auditActionColumn, "Unknown action")} AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${auditLogsTable} a`,
        "GROUP BY 1",
        "ORDER BY value DESC, label ASC",
        "LIMIT 10;",
      ].join("\n"),
    });
  }

  if (oauthClientsTable) {
    pushSeed({
      type: "scoreboard",
      title: "OAuth Clients",
      query: [
        "SELECT",
        "  COUNT(*)::bigint AS total_oauth_clients,",
        "  'oauth clients' AS label",
        `FROM ${oauthClientsTable} oc;`,
      ].join("\n"),
    });
  }

  if (identitiesTable) {
    if (identityProviderColumn) {
      pushSeed({
        type: "pie",
        title: "Identities by Provider",
        query: [
          "SELECT",
          `  ${buildPgTextExpr("i", identityProviderColumn, "Unknown provider")} AS label,`,
          "  COUNT(*)::bigint AS value",
          `FROM ${identitiesTable} i`,
          "GROUP BY 1",
          "ORDER BY value DESC, label ASC",
          "LIMIT 8;",
        ].join("\n"),
      });
    } else if (identityIdColumn) {
      pushSeed({
        type: "scoreboard",
        title: "Linked Identities",
        query: [
          "SELECT",
          "  COUNT(*)::bigint AS total_identities,",
          "  'identities' AS label",
          `FROM ${identitiesTable} i;`,
        ].join("\n"),
      });
    }
  }

  if (productCreatedAtColumn && productsTable) {
    pushSeed({
      type: "line",
      title: "Products Added by Month",
      query: [
        "SELECT",
        `  TO_CHAR(DATE_TRUNC('month', p.${quotePgIdentifier(productCreatedAtColumn)}), 'YYYY-MM') AS label,`,
        "  COUNT(*)::bigint AS value",
        `FROM ${productsTable} p`,
        `WHERE p.${quotePgIdentifier(productCreatedAtColumn)} IS NOT NULL`,
        "GROUP BY 1",
        "ORDER BY 1;",
      ].join("\n"),
    });
  }

  if (seeds.length < 6) {
    return null;
  }

  return {
    title: "Commerce & Ops Dashboard",
    widgets: seeds,
  };
}

