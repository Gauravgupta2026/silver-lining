"use client";

import type { ReactNode } from "react";

/** All actions share the guide's radius and monochrome palette. */
export const GHOST = "ui-button ui-button-secondary";
/** Labels and values use the guide's monospace stamp style. */
export const ANNOTATION = "field-label";

const roundTo = (v: number, places: number) => Number(v.toFixed(places));

/** One row per slider: label, track, value. Halves the panel height versus stacked rows. */
export function Slider(props: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; hint?: string; testId?: string }) {
  return (
    <label className="studio-slider" title={props.hint}>
      <span className="slider-label">{props.label}</span>
      <input
        type="range"
        data-testid={props.testId}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="w-full"
      />
      <span className={`${ANNOTATION} text-right tabular-nums`}>{roundTo(props.value, 2)}</span>
    </label>
  );
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="studio-section">
      <div className="studio-section-heading">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Text-only inline action (Surprise me, Reset): underlined ink, no fill. */
export function TextAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="text-action">
      {children}
    </button>
  );
}

/** A dark outline marks the selected option without competing with primary actions. */
export function Choice<T extends string>(props: { value: T; current: T; onSelect: (v: T) => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      title={props.title}
      aria-pressed={props.value === props.current}
      onClick={() => props.onSelect(props.value)}
      className="ui-choice"
    >
      {props.children}
    </button>
  );
}

export function PanelToggle({ expanded, onToggle, className }: { expanded: boolean; onToggle: () => void; className: string }) {
  const label = expanded ? "Hide panel" : "Show panel";
  return (
    <button type="button" aria-label={label} title={label} aria-expanded={expanded} aria-controls="studio-panel" onClick={onToggle} className={`${className} ui-button ui-button-secondary`}>
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M15 4v16" />
        {expanded && <path d="M16 5h4v14h-4z" fill="currentColor" opacity="0.15" stroke="none" />}
      </svg>
    </button>
  );
}

/** WAI-ARIA tab strip with arrow, Home and End keys. Panels are rendered by the caller. */
export function PanelTabs<K extends string>(props: { groups: readonly { key: K; label: string }[]; current: K; onSelect: (key: K) => void }) {
  const { groups, current, onSelect } = props;
  return (
    <div className="studio-group-tabs" role="tablist" aria-label="Control groups">
      {groups.map((group, index) => (
        <button
          key={group.key}
          id={`group-tab-${group.key}`}
          type="button"
          role="tab"
          aria-controls={`group-${group.key}`}
          aria-selected={current === group.key}
          tabIndex={current === group.key ? 0 : -1}
          onClick={() => onSelect(group.key)}
          onKeyDown={(event) => {
            const last = groups.length - 1;
            const next = event.key === "Home" ? 0 : event.key === "End" ? last : event.key === "ArrowRight" ? (index + 1) % groups.length : event.key === "ArrowLeft" ? (index + last) % groups.length : null;
            if (next === null) return;
            event.preventDefault();
            onSelect(groups[next].key);
            document.getElementById(`group-tab-${groups[next].key}`)?.focus();
          }}
        >
          {group.label}
        </button>
      ))}
    </div>
  );
}
