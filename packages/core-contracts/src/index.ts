// Core extension contracts, TypeScript side (design 0001 §7.1, §7.6). Contract version 0.1.0.
// Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
import type { ComponentType } from 'react';

export type DataClass = 'C0' | 'C1' | 'C2' | 'C3';
/** Framework roles have no prefix; module roles are `<module>.<role>`. */
export type RoleId = string;
/** `<module>.<permission>`. Routes and screens are guarded by permission, never by role. */
export type PermissionId = string;

export interface Route {
  path: string;
  permission?: PermissionId;
  load: () => Promise<{ default: ComponentType }>;
}

export interface Screen {
  id: string;
  variant: 'citizen' | 'gabinete';
  permission?: PermissionId;
  load: () => Promise<{ default: ComponentType }>;
}

export interface PublishContext {
  generation: number;
}

/** A module asks the core to run a fixed projection (packages/core-publish/projections) over these ids. */
export interface BundleRequest {
  /** Bundle name; module bundles are prefixed `<short>.`. */
  name: string;
  projection: string;
  ids: string[];
}

export interface PublishTarget {
  id: string;
  bundles: (ctx: PublishContext) => Promise<BundleRequest[]>;
}

declare const published: unique symbol;
/** Constructed only by core-publish from a projection; modules cannot build one. */
export type PublishedRecord = { readonly [published]: true; id: string; updated_at: string };

export interface JobRequest {
  /** `<short>.<name>` */
  queue: string;
  /** References only (ids, storage keys); never personal data. */
  payload: Record<string, unknown>;
  idempotency_key?: string;
  data_class: DataClass;
}

export interface ContentEnricher {
  id: string;
  onSave: (ref: { contentId: string; version: number }) => JobRequest | null;
}

/** Exports of a module's `web` entry (mandato.module.json). */
export interface WebModule {
  routes: Route[];
  publishTargets?: PublishTarget[];
  contentEnrichers?: ContentEnricher[];
}

/** Exports of a module's `mobile` entry. */
export interface MobileModule {
  screens: Screen[];
}
