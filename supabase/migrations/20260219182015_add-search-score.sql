set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.hybrid_search(query_text text, query_embedding extensions.vector, match_count integer, search_tables text[] DEFAULT ARRAY['messages'::text, 'files'::text, 'memories'::text], filter_type public.enum_memory_type[] DEFAULT NULL::public.enum_memory_type[], filter_session_id uuid DEFAULT NULL::uuid, filter_role public.enum_message_role[] DEFAULT NULL::public.enum_message_role[], filter_bucket text DEFAULT NULL::text, filter_object_path_prefix text DEFAULT NULL::text, full_text_weight double precision DEFAULT 1, semantic_weight double precision DEFAULT 1, rrf_k integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare
  v_tables text[];
  v_messages jsonb := '[]'::jsonb;
  v_files jsonb := '[]'::jsonb;
  v_memories jsonb := '[]'::jsonb;
begin
  -- Normalize table selectors (default: all)
  v_tables := array(
    select lower(trim(t))
    from unnest(coalesce(search_tables, array['messages', 'files', 'memories'])) as t
    where t is not null and length(trim(t)) > 0
  );

  if exists (
    select 1
    from unnest(v_tables) as t
    where t not in ('messages', 'files', 'memories')
  ) then
    raise exception
      'hybrid_search: invalid search_tables %. Allowed: messages, files, memories',
      v_tables;
  end if;

  if 'memories' = any(v_tables) then
    select coalesce(jsonb_agg(row_json order by score desc), '[]'::jsonb)
    into v_memories
    from (
      with base as (
        select *
        from memories
        where (filter_type is null or type = any(filter_type))
          and (filter_session_id is null or session_id = filter_session_id)
      ),
      full_text as (
        select
          id,
          row_number() over (
            order by ts_rank_cd(fts, websearch_to_tsquery(query_text)) desc
          ) as rank_ix
        from base
        where fts @@ websearch_to_tsquery(query_text)
        order by rank_ix
        limit least(match_count, 30) * 2
      ),
      semantic as (
        select
          id,
          row_number() over (order by embedding <#> query_embedding) as rank_ix
        from base
        where embedding is not null
        order by rank_ix
        limit least(match_count, 30) * 2
      )
      select
        (
          (to_jsonb(base) - 'embedding' - 'fts')
          || jsonb_build_object(
            'score',
            (
              coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
              coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight
            )
          )
        ) as row_json,
        (
          coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
          coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight
        ) as score
      from
        full_text
        full outer join semantic
          on full_text.id = semantic.id
        join base
          on coalesce(full_text.id, semantic.id) = base.id
      order by score desc
      limit least(match_count, 30)
    ) ranked;
  end if;

  if 'messages' = any(v_tables) then
    select coalesce(jsonb_agg(row_json order by score desc), '[]'::jsonb)
    into v_messages
    from (
      with base as (
        select *
        from messages
        where (filter_session_id is null or session_id = filter_session_id)
          and (filter_role is null or role = any(filter_role))
      ),
      full_text as (
        select
          id,
          row_number() over (
            order by ts_rank_cd(fts, websearch_to_tsquery(query_text)) desc
          ) as rank_ix
        from base
        where fts @@ websearch_to_tsquery(query_text)
        order by rank_ix
        limit least(match_count, 30) * 2
      ),
      semantic as (
        select
          id,
          row_number() over (order by embedding <#> query_embedding) as rank_ix
        from base
        where embedding is not null
        order by rank_ix
        limit least(match_count, 30) * 2
      )
      select
        (
          (to_jsonb(base) - 'embedding' - 'fts')
          || jsonb_build_object(
            'score',
            (
              coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
              coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight
            )
          )
        ) as row_json,
        (
          coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
          coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight
        ) as score
      from
        full_text
        full outer join semantic
          on full_text.id = semantic.id
        join base
          on coalesce(full_text.id, semantic.id) = base.id
      order by score desc
      limit least(match_count, 30)
    ) ranked;
  end if;

  if 'files' = any(v_tables) then
    select coalesce(jsonb_agg(row_json order by score desc), '[]'::jsonb)
    into v_files
    from (
      with base as (
        select *
        from files
        where (filter_bucket is null or bucket = filter_bucket)
          and (
            filter_object_path_prefix is null
            or object_path like filter_object_path_prefix || '%'
          )
      ),
      full_text as (
        select
          id,
          row_number() over (
            order by ts_rank_cd(fts, websearch_to_tsquery(query_text)) desc
          ) as rank_ix
        from base
        where fts @@ websearch_to_tsquery(query_text)
        order by rank_ix
        limit least(match_count, 30) * 2
      ),
      semantic as (
        select
          id,
          row_number() over (order by embedding <#> query_embedding) as rank_ix
        from base
        where embedding is not null
        order by rank_ix
        limit least(match_count, 30) * 2
      )
      select
        (
          (to_jsonb(base) - 'embedding' - 'fts')
          || jsonb_build_object(
            'score',
            (
              coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
              coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight
            )
          )
        ) as row_json,
        (
          coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight +
          coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight
        ) as score
      from
        full_text
        full outer join semantic
          on full_text.id = semantic.id
        join base
          on coalesce(full_text.id, semantic.id) = base.id
      order by score desc
      limit least(match_count, 30)
    ) ranked;
  end if;

  return jsonb_build_object(
    'messages', v_messages,
    'files', v_files,
    'memories', v_memories
  );
end;
$function$
;


