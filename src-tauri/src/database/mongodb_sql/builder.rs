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
