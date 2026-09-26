//! Builds MongoDB find/aggregate/count commands from a parsed `SelectStatement`.

use super::parser::{
    aggregate_spec, field_ref, AggregateFunc, AggregateSpec, Expr, OrderByTerm, SelectItem,
    SelectStatement,
};
use crate::database::mongodb::MongoQueryCommand;
use crate::database::query_common::MAX_QUERY_RESULT_ROWS;
use anyhow::{anyhow, Result};
use mongodb::bson::{doc, Bson, Document};

pub(super) fn build_command(statement: SelectStatement) -> Result<MongoQueryCommand> {
    let SelectStatement {
        distinct,
        items,
        from,
        where_expr,
        group_by,
        order_by,
        limit,
        offset,
    } = statement;

    if items.iter().any(|item| matches!(item, SelectItem::Star)) && items.len() > 1 {
        return Err(anyhow!("'*' cannot be combined with other select items"));
    }

    let star = items.iter().any(|item| matches!(item, SelectItem::Star));
    let columns: Vec<(String, Option<String>)> = items
        .iter()
        .filter_map(|item| match item {
            SelectItem::Column { path, alias } => Some((path.clone(), alias.clone())),
            _ => None,
        })
        .collect();
    let has_alias = columns.iter().any(|(_, alias)| alias.is_some());
    let aggregates: Vec<AggregateSpec> = items
        .iter()
        .filter_map(|item| match item {
            SelectItem::Aggregate { func, path, alias } => {
                Some(aggregate_spec(*func, path.clone(), alias.clone()))
            }
            _ => None,
        })
        .collect();

    if !group_by.is_empty() {
        if distinct {
            return Err(anyhow!("DISTINCT combined with GROUP BY is not supported"));
        }
        if star {
            return Err(anyhow!(
                "'*' is not supported with GROUP BY; list the grouped columns explicitly"
            ));
        }
        return build_group_by(
            from, &columns, aggregates, &group_by, where_expr, &order_by, limit, offset,
        );
    }

    if !aggregates.is_empty() {
        if distinct {
            return Err(anyhow!(
                "DISTINCT combined with aggregate functions is not supported"
            ));
        }
        if star {
            return Err(anyhow!("'*' cannot be combined with aggregate functions"));
        }
        if !columns.is_empty() {
            return Err(anyhow!(
                "mixing plain columns with aggregate functions requires GROUP BY"
            ));
        }
        if aggregates.len() == 1
            && aggregates[0].func == AggregateFunc::Count
            && aggregates[0].path.is_none()
        {
            // `SELECT COUNT(*) FROM ...` — sort/limit are no-ops for a single
            // scalar row, so the dedicated count command is enough.
            return Ok(MongoQueryCommand::CountDocuments {
                collection: from,
                filter: compile_where(where_expr),
            });
        }
        return build_whole_collection_aggregate(
            from, aggregates, where_expr, &order_by, limit, offset,
        );
    }

    if distinct {
        if star {
            return Err(anyhow!(
                "SELECT DISTINCT * is not supported; list the columns explicitly"
            ));
        }
        let distinct_columns: Vec<String> = columns.into_iter().map(|(path, _)| path).collect();
        return build_distinct(from, distinct_columns, where_expr, &order_by, limit, offset);
    }

    if has_alias {
        let projection_items: Vec<(String, String)> = columns
            .iter()
            .map(|(path, alias)| (alias.clone().unwrap_or_else(|| path.clone()), path.clone()))
            .collect();
        return build_alias_projection(
            from,
            projection_items,
            where_expr,
            &order_by,
            limit,
            offset,
        );
    }

    let projection = if star {
        None
    } else {
        let mut projection = Document::new();
        for (path, _) in &columns {
            projection.insert(path.clone(), Bson::Int32(1));
        }
        // SQL semantics: only the requested columns come back, so exclude _id
        // unless the query asked for it explicitly.
        if !columns
            .iter()
            .any(|(path, _)| path.eq_ignore_ascii_case("_id"))
        {
            projection.insert("_id", Bson::Int32(0));
        }
        Some(projection)
    };

    Ok(MongoQueryCommand::Find {
        collection: from,
        filter: compile_where(where_expr),
        projection,
        sort: build_plain_sort(&order_by)?,
        limit,
        skip: offset.map(|value| value.max(0) as u64),
    })
}

fn compile_where(where_expr: Option<Expr>) -> Document {
    where_expr.map(Expr::compile).unwrap_or_default()
}

fn build_plain_sort(order_by: &[OrderByTerm]) -> Result<Option<Document>> {
    if order_by.is_empty() {
        return Ok(None);
    }
    let mut sort = Document::new();
    for term in order_by {
        sort.insert(
            term.key.clone(),
            Bson::Int32(if term.descending { -1 } else { 1 }),
        );
    }
    Ok(Some(sort))
}

/// ORDER BY on aggregate-shaped results can only reference output fields, so
/// each term is resolved against the known output names.
fn build_resolved_sort(
    order_by: &[OrderByTerm],
    output_names: &[String],
) -> Result<Option<Document>> {
    if order_by.is_empty() {
        return Ok(None);
    }
    let mut sort = Document::new();
    for term in order_by {
        let resolved = output_names
            .iter()
            .find(|name| name.eq_ignore_ascii_case(&term.key))
            .ok_or_else(|| {
                anyhow!(
                    "ORDER BY '{}' must reference an output column or aggregate alias",
                    term.key
                )
            })?;
        sort.insert(
            resolved.clone(),
            Bson::Int32(if term.descending { -1 } else { 1 }),
        );
    }
    Ok(Some(sort))
}

fn push_sort_skip_limit(
    pipeline: &mut Vec<Document>,
    sort: Option<Document>,
    limit: Option<i64>,
    offset: Option<i64>,
) {
    if let Some(sort) = sort {
        pipeline.push(doc! { "$sort": sort });
    }
    if let Some(offset) = offset.filter(|value| *value > 0) {
        pipeline.push(doc! { "$skip": Bson::Int64(offset) });
    }
    if let Some(limit) = limit {
        let capped = limit.clamp(1, MAX_QUERY_RESULT_ROWS as i64);
        pipeline.push(doc! { "$limit": Bson::Int64(capped) });
    }
}

#[allow(clippy::too_many_arguments)]
fn build_group_by(
    collection: String,
    columns: &[(String, Option<String>)],
    aggregates: Vec<AggregateSpec>,
    group_by: &[String],
    where_expr: Option<Expr>,
    order_by: &[OrderByTerm],
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<MongoQueryCommand> {
    for (path, _) in columns {
        let grouped = group_by
            .iter()
            .any(|group| group.eq_ignore_ascii_case(path));
        if !grouped {
            return Err(anyhow!(
                "column '{path}' must appear in GROUP BY or be used in an aggregate function"
            ));
        }
    }

    let mut group_id = Document::new();
    for group in group_by {
        group_id.insert(group.clone(), field_ref(group));
    }
    let mut group_stage = Document::new();
    group_stage.insert("_id", Bson::Document(group_id));
    for aggregate in &aggregates {
        group_stage.insert(aggregate.output_name.clone(), aggregate.accumulator());
    }

    let mut pipeline = Vec::new();
    if let Some(where_expr) = where_expr {
        pipeline.push(doc! { "$match": where_expr.compile() });
    }
    pipeline.push(doc! { "$group": group_stage });

    let mut project_stage = Document::new();
    for group in group_by {
        project_stage.insert(group.clone(), Bson::String(format!("$_id.{group}")));
    }
    for aggregate in &aggregates {
        project_stage.insert(aggregate.output_name.clone(), Bson::Int32(1));
    }
    project_stage.insert("_id", Bson::Int32(0));
    pipeline.push(doc! { "$project": project_stage });

    let mut output_names: Vec<String> = group_by.to_vec();
    output_names.extend(aggregates.iter().map(|a| a.output_name.clone()));
    let sort = build_resolved_sort(order_by, &output_names)?;
    push_sort_skip_limit(&mut pipeline, sort, limit, offset);

    Ok(MongoQueryCommand::Aggregate {
        collection,
        pipeline,
    })
}

fn build_whole_collection_aggregate(
    collection: String,
    aggregates: Vec<AggregateSpec>,
    where_expr: Option<Expr>,
    order_by: &[OrderByTerm],
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<MongoQueryCommand> {
    let mut group_stage = Document::new();
    group_stage.insert("_id", Bson::Null);
    for aggregate in &aggregates {
        group_stage.insert(aggregate.output_name.clone(), aggregate.accumulator());
    }

    let mut pipeline = Vec::new();
    if let Some(where_expr) = where_expr {
        pipeline.push(doc! { "$match": where_expr.compile() });
    }
    pipeline.push(doc! { "$group": group_stage });

    let output_names: Vec<String> = aggregates
        .iter()
        .flat_map(|a| [a.output_name.clone(), a.expression_text.clone()])
        .collect();
    let sort = build_resolved_sort(order_by, &output_names)?;
    push_sort_skip_limit(&mut pipeline, sort, limit, offset);

    Ok(MongoQueryCommand::Aggregate {
        collection,
        pipeline,
    })
}

fn build_distinct(
    collection: String,
    columns: Vec<String>,
    where_expr: Option<Expr>,
    order_by: &[OrderByTerm],
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<MongoQueryCommand> {
    if columns.is_empty() {
        return Err(anyhow!("SELECT DISTINCT requires a column list"));
    }

    let mut group_id = Document::new();
    for column in &columns {
        group_id.insert(column.clone(), field_ref(column));
    }

    let mut pipeline = Vec::new();
    if let Some(where_expr) = where_expr {
        pipeline.push(doc! { "$match": where_expr.compile() });
    }
    let mut group_stage = Document::new();
    group_stage.insert("_id", Bson::Document(group_id));
    pipeline.push(doc! { "$group": group_stage });

    let mut project_stage = Document::new();
    for column in &columns {
        project_stage.insert(column.clone(), Bson::String(format!("$_id.{column}")));
    }
    project_stage.insert("_id", Bson::Int32(0));
    pipeline.push(doc! { "$project": project_stage });

    let sort = build_resolved_sort(order_by, &columns)?;
    push_sort_skip_limit(&mut pipeline, sort, limit, offset);

    Ok(MongoQueryCommand::Aggregate {
        collection,
        pipeline,
    })
}

fn build_alias_projection(
    collection: String,
    projection_items: Vec<(String, String)>,
    where_expr: Option<Expr>,
    order_by: &[OrderByTerm],
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<MongoQueryCommand> {
    // find() projections cannot rename fields, so aliased selects are served
    // by a $project aggregate stage instead.
    let mut project_stage = Document::new();
    for (output_name, path) in &projection_items {
        if output_name == path {
            project_stage.insert(output_name.clone(), Bson::Int32(1));
        } else {
            project_stage.insert(output_name.clone(), field_ref(path));
        }
    }
    project_stage.insert("_id", Bson::Int32(0));

    let mut pipeline = Vec::new();
    if let Some(where_expr) = where_expr {
        pipeline.push(doc! { "$match": where_expr.compile() });
    }
    pipeline.push(doc! { "$project": project_stage });

    let output_names: Vec<String> = projection_items
        .into_iter()
        .flat_map(|(output, path)| [output, path])
        .collect();
    let sort = build_resolved_sort(order_by, &output_names)?;
    push_sort_skip_limit(&mut pipeline, sort, limit, offset);

    Ok(MongoQueryCommand::Aggregate {
        collection,
        pipeline,
    })
}

#[cfg(test)]
mod tests {
    use super::super::translate_sql_statement;
    use crate::database::mongodb::MongoQueryCommand;
    use crate::database::query_common::MAX_QUERY_RESULT_ROWS;
    use anyhow::Result;
    use mongodb::bson::{doc, Document};

    fn translate(sql: &str) -> Result<MongoQueryCommand> {
        translate_sql_statement(sql).expect("input is SQL-shaped")
    }

    fn pipeline_keys(pipeline: &[Document]) -> Vec<String> {
        pipeline
            .iter()
            .map(|stage| stage.keys().next().cloned().unwrap_or_default())
            .collect()
    }

    #[test]
    fn non_sql_inputs_pass_through_to_the_shell_parser() {
        assert!(translate_sql_statement("db.users.find({})").is_none());
        assert!(translate_sql_statement("show dbs").is_none());
        assert!(translate_sql_statement("").is_none());
    }

    #[test]
    fn group_by_pipeline_orders_match_group_project_then_sort_skip_limit() {
        let command = translate(
            "SELECT status, COUNT(*) AS total, SUM(amount) AS revenue FROM orders \
             WHERE region = 'eu' GROUP BY status ORDER BY total DESC LIMIT 10 OFFSET 5",
        )
        .unwrap();
        let MongoQueryCommand::Aggregate { pipeline, .. } = command else {
            panic!("expected an aggregate pipeline");
        };
        assert_eq!(
            pipeline_keys(&pipeline),
            vec!["$match", "$group", "$project", "$sort", "$skip", "$limit"]
        );
        let group = pipeline[1].get_document("$group").unwrap();
        assert_eq!(
            group
                .get_document("_id")
                .unwrap()
                .get_str("status")
                .unwrap(),
            "$status"
        );
        let project = pipeline[2].get_document("$project").unwrap();
        assert_eq!(project.get_str("status").unwrap(), "$_id.status");
        assert_eq!(project.get_i32("_id").unwrap(), 0, "_id must be hidden");
    }

    #[test]
    fn order_by_resolves_aggregate_alias_case_insensitively() {
        let command =
            translate("SELECT status, COUNT(*) AS Total FROM users GROUP BY status ORDER BY total")
                .unwrap();
        let MongoQueryCommand::Aggregate { pipeline, .. } = command else {
            panic!("expected an aggregate pipeline");
        };
        let sort = pipeline
            .iter()
            .find_map(|stage| stage.get_document("$sort").ok())
            .expect("pipeline must contain a $sort stage");
        assert_eq!(sort.get_i32("Total").unwrap(), 1);
    }

    #[test]
    fn order_by_on_a_non_output_column_is_rejected() {
        let result =
            translate("SELECT status, COUNT(*) AS total FROM users GROUP BY status ORDER BY name");
        let error = result.unwrap_err().to_string();
        assert!(error.contains("ORDER BY"), "{error}");

        // Same rule applies on the DISTINCT path.
        assert!(translate("SELECT DISTINCT city FROM users ORDER BY name").is_err());
    }

    #[test]
    fn pipeline_limit_is_clamped_to_the_query_row_cap() {
        let command =
            translate("SELECT status, COUNT(*) AS n FROM users GROUP BY status LIMIT 999999")
                .unwrap();
        let MongoQueryCommand::Aggregate { pipeline, .. } = command else {
            panic!("expected an aggregate pipeline");
        };
        let last = pipeline.last().unwrap();
        assert_eq!(
            last.get_i64("$limit").unwrap(),
            MAX_QUERY_RESULT_ROWS as i64
        );
    }

    #[test]
    fn zero_offset_emits_no_skip_stage() {
        let command =
            translate("SELECT status, COUNT(*) AS n FROM users GROUP BY status LIMIT 5 OFFSET 0")
                .unwrap();
        let MongoQueryCommand::Aggregate { pipeline, .. } = command else {
            panic!("expected an aggregate pipeline");
        };
        assert_eq!(
            pipeline_keys(&pipeline),
            vec!["$group", "$project", "$limit"]
        );
    }

    #[test]
    fn star_cannot_mix_with_columns_or_aggregates() {
        assert!(translate("SELECT *, name FROM users").is_err());
        assert!(translate("SELECT *, COUNT(*) FROM users").is_err());
        assert!(translate("SELECT * FROM users GROUP BY status").is_err());
        assert!(translate("SELECT DISTINCT * FROM users").is_err());
        // Plain columns require GROUP BY once aggregates appear.
        assert!(translate("SELECT name, COUNT(*) FROM users").is_err());
        // DISTINCT cannot combine with aggregates or GROUP BY either.
        assert!(translate("SELECT DISTINCT COUNT(*) FROM users").is_err());
        assert!(translate("SELECT DISTINCT status FROM users GROUP BY status").is_err());
    }

    #[test]
    fn count_star_with_filter_becomes_count_documents() {
        let command = translate("SELECT COUNT(*) FROM users WHERE active = true").unwrap();
        let MongoQueryCommand::CountDocuments { collection, filter } = command else {
            panic!("expected countDocuments");
        };
        assert_eq!(collection, "users");
        assert_eq!(filter, doc! { "active": true });
    }

    #[test]
    fn whole_collection_aggregates_still_expose_output_names_for_sort() {
        // ORDER BY may reference the aggregate expression text (SUM(amount))
        // or its output name.
        let command =
            translate("SELECT SUM(amount) AS total FROM orders ORDER BY total DESC").unwrap();
        let MongoQueryCommand::Aggregate { pipeline, .. } = command else {
            panic!("expected an aggregate pipeline");
        };
        assert_eq!(pipeline_keys(&pipeline), vec!["$group", "$sort"]);
    }
}
