import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec('pragma foreign_keys = ON');
  migrate(database);
  return database;
}

export function migrate(database: DatabaseSync): void {
  database.exec(`
    create table if not exists projects (
      project_id text primary key,
      name text not null,
      case_pack_checksum text not null,
      created_at text not null
    );

    create table if not exists case_pack_fragments (
      fragment_id text primary key,
      role text not null,
      name text not null,
      immutable integer not null,
      content_hash text not null,
      content_json text not null
    );

    create table if not exists project_case_pack (
      project_id text primary key references projects(project_id),
      case_pack_json text not null,
      checksum text not null
    );

    create table if not exists artifact_versions (
      artifact_id text not null,
      version integer not null,
      content_id text primary key,
      parent_content_id text references artifact_versions(content_id),
      role text not null,
      source_fragment_ids_json text not null,
      interpretation_version text not null,
      quantity_json text not null,
      content_hash text not null,
      created_at text not null,
      unique(artifact_id, version)
    );

    create table if not exists runs (
      run_id text primary key,
      project_id text not null references projects(project_id),
      parent_run_id text references runs(run_id),
      scenario_id text not null,
      input_id text not null,
      parameters_json text not null,
      parameter_fingerprint text not null,
      status text not null,
      diagnostics_json text not null,
      direct_sources_json text not null,
      created_at text not null
    );

    create table if not exists run_pixels (
      project_id text not null references projects(project_id),
      run_id text not null references runs(run_id),
      pixel_id text not null,
      row_no integer not null,
      col_no integer not null,
      wrapped_phase_rad real,
      amplitude real,
      quality_score real,
      valid integer not null,
      component_id text,
      refs_json text not null,
      primary key(run_id, pixel_id)
    );

    create table if not exists run_edges (
      project_id text not null references projects(project_id),
      run_id text not null references runs(run_id),
      edge_id text not null,
      from_pixel_id text not null,
      to_pixel_id text not null,
      row_a integer not null,
      col_a integer not null,
      row_b integer not null,
      col_b integer not null,
      wrapped_delta_rad real not null,
      nearest_offset_turns integer not null,
      explicit_offset_turns integer,
      selected_offset_turns integer,
      edge_kind text not null,
      quality_score real not null,
      component_id text,
      diagnostic text,
      refs_json text not null,
      primary key(run_id, edge_id)
    );

    create table if not exists run_candidates (
      project_id text not null references projects(project_id),
      run_id text not null references runs(run_id),
      candidate_id text not null,
      candidate_number integer not null,
      root_pixel_id text not null,
      tree_edge_ids_json text not null,
      status text not null,
      status_reason text not null,
      legal_integer_offsets_json text not null,
      rejected_edge_ids_json text not null,
      refs_json text not null,
      primary key(run_id, candidate_id)
    );

    create table if not exists run_cycles (
      project_id text not null references projects(project_id),
      run_id text not null references runs(run_id),
      candidate_id text not null,
      cycle_id text not null,
      anchor_pixel_id text not null,
      edge_ids_json text not null,
      residual_turns real,
      status text not null,
      diagnostic text not null,
      refs_json text not null,
      primary key(run_id, candidate_id, cycle_id)
    );

    create table if not exists run_candidate_pixels (
      project_id text not null references projects(project_id),
      run_id text not null references runs(run_id),
      candidate_id text not null,
      value_id text not null,
      pixel_id text not null,
      row_no integer not null,
      col_no integer not null,
      unwrapped_phase_rad real,
      relative_calibration_phase_rad real,
      status text not null,
      refs_json text not null,
      primary key(run_id, candidate_id, value_id)
    );

    create table if not exists run_heights (
      project_id text not null references projects(project_id),
      run_id text not null references runs(run_id),
      candidate_id text not null,
      height_id text not null,
      pixel_id text not null,
      row_no integer not null,
      col_no integer not null,
      height_nanometers real,
      transfer_chain_json text not null,
      status text not null,
      diagnostic text,
      refs_json text not null,
      primary key(run_id, candidate_id, height_id)
    );

    create table if not exists review_events (
      event_id text primary key,
      project_id text not null references projects(project_id),
      sequence_no integer not null unique,
      event_type text not null,
      target_kind text not null,
      target_id text not null,
      run_id text references runs(run_id),
      candidate_id text,
      payload_json text not null,
      direct_sources_json text not null,
      created_at text not null
    );

    create table if not exists local_locks (
      lock_id text primary key,
      project_id text not null references projects(project_id),
      run_id text references runs(run_id),
      candidate_id text,
      row_a integer not null,
      col_a integer not null,
      row_b integer not null,
      col_b integer not null,
      required_offset_turns integer not null,
      created_event_id text not null references review_events(event_id),
      revoked_event_id text references review_events(event_id),
      active integer not null,
      created_at text not null
    );
  `);
}
