-- Phase 3E. Originals never enter Storage; only the verified server WebP output does.
create table public.project_photos (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  user_id uuid not null,
  object_path text not null unique,
  mime_type text not null default 'image/webp' check (mime_type='image/webp'),
  width integer check (width between 1 and 1600),
  height integer check (height between 1 and 1600),
  byte_size integer check (byte_size between 1 and 10485760),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  retired_at timestamptz,
  cleaned_at timestamptz,
  constraint photo_owner_fk foreign key (project_id,user_id) references public.projects(id,user_id) on delete restrict,
  constraint photo_identity unique(id,project_id,user_id),
  constraint photo_path check (object_path=user_id::text||'/'||project_id::text||'/'||id::text||'.webp'),
  constraint photo_dimensions check ((width is null and height is null and byte_size is null) or (width is not null and height is not null and byte_size is not null)),
  constraint photo_cleanup check (cleaned_at is null or retired_at is not null)
);
alter table public.projects add column cover_photo_id uuid;
alter table public.projects add constraint project_cover_owner_fk foreign key(cover_photo_id,id,user_id) references public.project_photos(id,project_id,user_id) on delete restrict;
create index project_photos_cleanup_idx on public.project_photos(user_id,project_id,retired_at) where retired_at is not null and cleaned_at is null;
create table public.project_photo_changes (
  user_id uuid not null,
  request_id uuid not null,
  project_id uuid not null,
  action text not null check(action in ('upload','delete')),
  expected_revision bigint not null check(expected_revision between 0 and 9007199254740990),
  source_hash text,
  content_hash text,
  photo_id uuid,
  status text not null default 'pending' check(status in ('pending','committed','abandoned')),
  result jsonb,
  created_at timestamptz not null default clock_timestamp(),
  primary key(user_id,request_id),
  foreign key(project_id,user_id) references public.projects(id,user_id) on delete restrict,
  foreign key(photo_id,project_id,user_id) references public.project_photos(id,project_id,user_id),
  check((action='upload' and source_hash ~ '^[a-f0-9]{64}$' and content_hash ~ '^[a-f0-9]{64}$' and source_hash is not null and content_hash is not null and photo_id is not null) or (action='delete' and source_hash is null and content_hash is null and photo_id is null)),
  check((status='committed')=(result is not null))
);
alter table public.project_photos enable row level security;
alter table public.project_photo_changes enable row level security;
revoke all on public.project_photos,public.project_photo_changes from public,anon,authenticated;
grant select on public.project_photos to authenticated;
grant select on public.project_photos,public.project_photo_changes to service_role;
create policy "read current own project photo" on public.project_photos for select to authenticated using (
  user_id=auth.uid() and width is not null and retired_at is null and exists(select 1 from public.projects p where p.id=project_id and p.user_id=auth.uid() and p.deleted_at is null and p.cover_photo_id=project_photos.id)
);
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('project-photos','project-photos',false,10485760,array['image/webp']);
create policy "read current own project photo object" on storage.objects for select to authenticated using (
  bucket_id='project-photos' and exists(select 1 from public.project_photos ph where ph.object_path=name and ph.user_id=auth.uid())
);
-- No INSERT/UPDATE/DELETE policies for clients: upload/delete are authenticated server routes only.
create function public.begin_project_photo_change(p_user_id uuid,p_project_id uuid,p_request_id uuid,p_expected_revision bigint,p_action text,p_source_hash text default null,p_content_hash text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.projects; c public.project_photo_changes; ph public.project_photos;
begin
  select * into p from public.projects where id=p_project_id and user_id=p_user_id for update;
  if not found then raise exception 'project_not_found' using errcode='P0002'; end if;
  select * into c from public.project_photo_changes where user_id=p_user_id and request_id=p_request_id for update;
  if found then
    if c.project_id<>p_project_id or c.action<>p_action or c.expected_revision<>p_expected_revision or c.source_hash is distinct from p_source_hash or c.content_hash is distinct from p_content_hash then raise exception 'photo_request_reused' using errcode='22023';end if;
    if c.status='committed' then return c.result||jsonb_build_object('duplicate',true);end if;
    if c.status='abandoned' then raise exception 'photo_request_abandoned' using errcode='22023';end if;
    if p.deleted_at is not null then raise exception 'project_unavailable' using errcode='P0002';end if;
    select * into ph from public.project_photos where id=c.photo_id;
    return jsonb_build_object('status','pending','photoId',c.photo_id,'path',ph.object_path);
  end if;
  if p.deleted_at is not null then raise exception 'project_unavailable' using errcode='P0002';end if;
  if p.revision<>p_expected_revision then raise exception 'project_revision_conflict' using errcode='40001';end if;
  if p_action='upload' then
    ph.id:=gen_random_uuid();
    insert into public.project_photos(id,project_id,user_id,object_path,content_hash) values(ph.id,p.id,p_user_id,p_user_id::text||'/'||p.id::text||'/'||ph.id::text||'.webp',p_content_hash) returning * into ph;
  end if;
  insert into public.project_photo_changes(user_id,request_id,project_id,action,expected_revision,source_hash,content_hash,photo_id)
    values(p_user_id,p_request_id,p_project_id,p_action,p_expected_revision,p_source_hash,p_content_hash,ph.id);
  return jsonb_build_object('status','pending','photoId',ph.id,'path',ph.object_path);
end $$;
create function public.commit_project_photo_change(p_user_id uuid,p_project_id uuid,p_request_id uuid,p_width integer default null,p_height integer default null,p_byte_size integer default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.projects; c public.project_photo_changes; ph public.project_photos; answer jsonb;
begin
  select * into p from public.projects where id=p_project_id and user_id=p_user_id for update;
  if not found then raise exception 'project_not_found' using errcode='P0002';end if;
  select * into c from public.project_photo_changes where user_id=p_user_id and project_id=p.id and request_id=p_request_id for update;
  if not found then raise exception 'photo_request_not_found' using errcode='P0002';end if;
  if c.status='committed' then return c.result||jsonb_build_object('duplicate',true);end if;
  if c.status<>'pending' then raise exception 'photo_request_abandoned' using errcode='22023';end if;
  if p.deleted_at is not null then raise exception 'project_unavailable' using errcode='P0002';end if;
  if p.revision<>c.expected_revision then raise exception 'project_revision_conflict' using errcode='40001';end if;
  if c.action='upload' then
    select * into ph from public.project_photos where id=c.photo_id;
    if p_width is null or p_height is null or p_byte_size is null or not exists(select 1 from storage.objects where bucket_id='project-photos' and name=ph.object_path) then raise exception 'photo_upload_incomplete' using errcode='23514';end if;
    update public.project_photos set width=p_width,height=p_height,byte_size=p_byte_size where id=ph.id;
  end if;
  update public.project_photos set retired_at=clock_timestamp() where id=p.cover_photo_id;
  update public.projects set cover_photo_id=c.photo_id,revision=revision+1,updated_at=clock_timestamp() where id=p.id returning * into p;
  answer:=jsonb_build_object('status','committed','photoId',p.cover_photo_id,'revision',p.revision);
  update public.project_photo_changes set status='committed',result=answer where user_id=p_user_id and request_id=p_request_id;
  return answer;
end $$;
create function public.abandon_project_photo_change(p_user_id uuid,p_project_id uuid,p_request_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare c public.project_photo_changes;
begin
  perform 1 from public.projects where id=p_project_id and user_id=p_user_id for update;
  if not found then raise exception 'project_not_found' using errcode='P0002';end if;
  select * into c from public.project_photo_changes where user_id=p_user_id and project_id=p_project_id and request_id=p_request_id for update;
  if found and c.status='pending' then
    update public.project_photo_changes set status='abandoned' where user_id=p_user_id and request_id=p_request_id;
    update public.project_photos set retired_at=clock_timestamp() where id=c.photo_id;
  end if;
end $$;
create function public.project_photo_cleanup_candidates(p_user_id uuid,p_project_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.projects where id=p_project_id and user_id=p_user_id for update;
  if not found then raise exception 'project_not_found' using errcode='P0002';end if;
  -- Staged operations left by a closed tab expire after 24 hours, never active covers.
  update public.project_photos ph set retired_at=clock_timestamp() where ph.id in (
    select c.photo_id from public.project_photo_changes c where c.user_id=p_user_id and c.project_id=p_project_id and c.status='pending' and c.created_at<clock_timestamp()-interval '24 hours'
  );
  update public.project_photo_changes set status='abandoned' where user_id=p_user_id and project_id=p_project_id and status='pending' and created_at<clock_timestamp()-interval '24 hours';
  return coalesce((select jsonb_agg(jsonb_build_object('id',ph.id,'path',ph.object_path)) from public.project_photos ph where ph.user_id=p_user_id and ph.project_id=p_project_id and ph.retired_at is not null and ph.cleaned_at is null and (ph.width is not null or ph.retired_at<clock_timestamp()-interval '15 minutes') and not exists(select 1 from public.projects p where p.cover_photo_id=ph.id)),'[]'::jsonb);
end $$;
create function public.confirm_project_photo_cleanup(p_user_id uuid,p_project_id uuid,p_photo_id uuid)
returns void language sql security definer set search_path='' as $$
  update public.project_photos ph set cleaned_at=clock_timestamp() where ph.id=p_photo_id and ph.user_id=p_user_id and ph.project_id=p_project_id and ph.retired_at is not null and not exists(select 1 from public.projects p where p.cover_photo_id=ph.id)
$$;
revoke all on function public.begin_project_photo_change(uuid,uuid,uuid,bigint,text,text,text),public.commit_project_photo_change(uuid,uuid,uuid,integer,integer,integer),public.abandon_project_photo_change(uuid,uuid,uuid),public.project_photo_cleanup_candidates(uuid,uuid),public.confirm_project_photo_cleanup(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.begin_project_photo_change(uuid,uuid,uuid,bigint,text,text,text),public.commit_project_photo_change(uuid,uuid,uuid,integer,integer,integer),public.abandon_project_photo_change(uuid,uuid,uuid),public.project_photo_cleanup_candidates(uuid,uuid),public.confirm_project_photo_cleanup(uuid,uuid,uuid) to service_role;
