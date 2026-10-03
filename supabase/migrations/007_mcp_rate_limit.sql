-- MCP 2026 工具调用限流：计数放在 Postgres，不能被多实例或进程重启绕过。
begin;

create table private.mcp_request_budgets (
  owner_uuid uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  window_started timestamptz not null,
  request_count integer not null check (request_count between 1 and 121),
  primary key (owner_uuid, client_id)
);
alter table private.mcp_request_budgets enable row level security;
revoke all on private.mcp_request_budgets from public, anon, authenticated;

create function public.consume_mcp_request_budget()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := private.assert_authenticated_user();
  client text := nullif(auth.jwt()->>'client_id', '');
  stamp timestamptz := clock_timestamp();
  budget private.mcp_request_budgets;
begin
  if client is null then raise exception 'OAuth authorization required' using errcode = '42501'; end if;
  insert into private.mcp_request_budgets as b (owner_uuid, client_id, window_started, request_count)
  values (owner_id, client, stamp, 1)
  on conflict (owner_uuid, client_id) do update set
    window_started = case when b.window_started <= stamp - interval '1 minute' then stamp else b.window_started end,
    request_count = case when b.window_started <= stamp - interval '1 minute' then 1 else least(121, b.request_count + 1) end
  returning * into budget;
  return jsonb_build_object(
    'allowed', budget.request_count <= 120,
    'limit', 120,
    'remaining', greatest(0, 120 - budget.request_count),
    'retryAfterSeconds', greatest(1, ceil(extract(epoch from budget.window_started + interval '1 minute' - stamp))::integer)
  );
end;
$$;
revoke all on function public.consume_mcp_request_budget() from public, anon;
grant execute on function public.consume_mcp_request_budget() to authenticated;

-- 复用已有的每小时清理任务，不增加调度服务。
create or replace function private.cleanup_agent_data()
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from private.board_trash where expires_at <= now();
  delete from private.board_audit where occurred_at <= now() - interval '90 days';
  delete from private.agent_requests where created_at <= now() - interval '1 day';
  delete from private.mcp_request_budgets where window_started <= now() - interval '1 day';
end;
$$;
revoke all on function private.cleanup_agent_data() from public, anon, authenticated;
commit;
