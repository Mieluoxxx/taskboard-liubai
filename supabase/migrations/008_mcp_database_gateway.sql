-- MCP 入站令牌不再用作上游 HTTP RPC 凭据。专用数据库角色仅可调用固定操作分派器。
begin;

create role liubai_mcp_gateway nologin noinherit;
grant usage on schema public to liubai_mcp_gateway;
alter table private.agent_config add column oauth_issuer text;

create function public.mcp_dispatch(p_claims jsonb, p_method text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare issuer text; result jsonb; restore_ids uuid[];
begin
  select oauth_issuer into issuer from private.agent_config where singleton;
  if issuer is null then raise exception 'MCP database gateway is not configured' using errcode = '55000'; end if;
  if jsonb_typeof(p_claims) is distinct from 'object' or jsonb_typeof(p_args) is distinct from 'object'
    or p_claims->>'role' is distinct from 'authenticated'
    or p_claims->>'iss' is distinct from issuer
    or coalesce(p_claims->>'client_id', '') = '' or coalesce(p_claims->>'session_id', '') = ''
    or jsonb_typeof(p_claims->'exp') is distinct from 'number'
  then raise exception 'Invalid gateway principal' using errcode = '42501'; end if;
  if (p_claims->>'exp')::numeric <= extract(epoch from clock_timestamp()) then
    raise exception 'OAuth session expired' using errcode = '42501';
  end if;
  -- 事务局部上下文随本条查询结束自动清除，不泄漏到池中的下一个调用者。
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', p_claims::text, true);
  perform private.assert_authenticated_user();

  case p_method
    when 'consume_mcp_request_budget' then result := public.consume_mcp_request_budget();
    when 'get_private_board' then
      select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) into result from public.get_private_board() b;
    when 'get_board_trash' then
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into result
      from public.get_board_trash(coalesce((p_args->>'p_limit')::integer, 50), coalesce((p_args->>'p_offset')::integer, 0), (p_args->>'p_id')::uuid) t;
    when 'get_board_audit' then
      select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) into result
      from public.get_board_audit(coalesce((p_args->>'p_limit')::integer, 50), coalesce((p_args->>'p_offset')::integer, 0)) a;
    when 'get_agent_request' then
      result := public.get_agent_request((p_args->>'p_request_id')::uuid, p_args->>'p_fingerprint');
    when 'commit_agent_board' then
      select coalesce(array_agg(value::uuid), '{}'::uuid[]) into restore_ids from jsonb_array_elements_text(coalesce(p_args->'p_restore_ids', '[]'::jsonb));
      result := public.commit_agent_board((p_args->>'p_expected_revision')::bigint, p_args->'p_snapshot', (p_args->>'p_request_id')::uuid, p_args->>'p_fingerprint', restore_ids);
    when 'record_board_failure' then
      perform public.record_board_failure(p_args->>'p_result'); result := null;
    else raise exception 'Operation is not available to MCP gateway' using errcode = '42501';
  end case;
  return result;
end;
$$;
revoke all on function public.mcp_dispatch(jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.mcp_dispatch(jsonb, text, jsonb) to liubai_mcp_gateway;
-- LOGIN 密码和 oauth_issuer 在部署时单独配置，不把任何数据库口令写入迁移或仓库。
commit;
