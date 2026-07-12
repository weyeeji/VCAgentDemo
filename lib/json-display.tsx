"use client";

import type { ReactNode } from "react";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asString(item)).filter(Boolean);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="json-read-section">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function BulletList({ items, empty = "暂无" }: { items: string[]; empty?: string }) {
  if (!items.length) return <p className="json-read-empty">{empty}</p>;
  return (
    <ul className="json-read-list">
      {items.map((item, index) => <li key={`${index}-${item.slice(0, 24)}`}>{item}</li>)}
    </ul>
  );
}

function KeyValueGrid({ rows }: { rows: Array<{ label: string; value: ReactNode }> }) {
  const visible = rows.filter((row) => row.value !== null && row.value !== undefined && row.value !== "");
  if (!visible.length) return null;
  return (
    <dl className="json-read-kv">
      {visible.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ScoreBadge({ label, score }: { label: string; score: number | null }) {
  if (score === null) return null;
  return (
    <div className="json-read-score">
      <span>{label}</span>
      <strong>{Math.round(score)}</strong>
    </div>
  );
}

function FitBlock({
  title,
  score,
  positive,
  negative,
}: {
  title: string;
  score: number | null;
  positive: string[];
  negative: string[];
}) {
  if (score === null && !positive.length && !negative.length) return null;
  return (
    <Section title={title}>
      <ScoreBadge label="匹配度" score={score} />
      {positive.length ? (
        <>
          <p className="json-read-label">积极信号</p>
          <BulletList items={positive} empty="" />
        </>
      ) : null}
      {negative.length ? (
        <>
          <p className="json-read-label">消极信号</p>
          <BulletList items={negative} empty="" />
        </>
      ) : null}
    </Section>
  );
}

function statusTone(status: string): string {
  if (status === "reject") return "danger";
  if (status === "pending") return "warn";
  if (status === "continue") return "info";
  return "neutral";
}

function renderPublicEvaluation(data: Record<string, unknown>) {
  const status = asString(data.status) || "未知";
  const matchScore = asNumber(data.match_score);
  const confidence = asNumber(data.confidence);
  return (
    <div className="json-read-body">
      <div className="json-read-hero">
        <div>
          <p className="json-read-kicker">公共匹配结果</p>
          <h3>{asString(data.summary) || "暂无摘要"}</h3>
        </div>
        <div className="json-read-badges">
          <span className={`json-read-badge ${statusTone(status)}`}>{status}</span>
          <ScoreBadge label="匹配分" score={matchScore} />
          <ScoreBadge label="置信度" score={confidence} />
        </div>
      </div>
      <KeyValueGrid rows={[
        { label: "对话 ID", value: asString(data.conversation_id) },
        { label: "投资人 Agent", value: asString(data.investor_agent_id) },
        { label: "创业者 Agent", value: asString(data.founder_agent_id) },
        { label: "结束原因", value: asString(data.conversation_end_reason) },
        { label: "建议下一步", value: asString(data.recommended_next_action) },
      ]} />
      <Section title="匹配点"><BulletList items={asStringList(data.matching_points)} /></Section>
      <Section title="不匹配点"><BulletList items={asStringList(data.mismatching_points)} /></Section>
      <Section title="已核实事实"><BulletList items={asStringList(data.verified_facts)} /></Section>
      <Section title="未验证声明"><BulletList items={asStringList(data.unverified_claims)} /></Section>
      <Section title="推断"><BulletList items={asStringList(data.inferences)} /></Section>
      <Section title="风险"><BulletList items={asStringList(data.risks)} /></Section>
      <Section title="待确认问题"><BulletList items={asStringList(data.open_questions)} /></Section>
    </div>
  );
}

function renderInvestorMemory(data: Record<string, unknown>) {
  const fit = isObject(data.investment_fit) ? data.investment_fit : {};
  return (
    <div className="json-read-body">
      <div className="json-read-hero">
        <div>
          <p className="json-read-kicker">投资人私有记忆</p>
          <h3>{asString(data.summary) || "暂无摘要"}</h3>
        </div>
      </div>
      <KeyValueGrid rows={[
        { label: "Agent ID", value: asString(data.agent_id) },
        { label: "对方 ID", value: asString(data.counterparty_id) },
        { label: "建议下一步", value: asString(data.recommended_next_action) },
        { label: "来源轮次", value: asStringList(data.source_turns).join("、") || null },
      ]} />
      <Section title="关键事实"><BulletList items={asStringList(data.key_facts)} /></Section>
      <Section title="未验证声明"><BulletList items={asStringList(data.unverified_claims)} /></Section>
      <FitBlock
        title="投资匹配判断"
        score={asNumber(fit.score)}
        positive={asStringList(fit.positive_signals)}
        negative={asStringList(fit.negative_signals)}
      />
      <Section title="风险"><BulletList items={asStringList(data.risks)} /></Section>
      <Section title="待确认问题"><BulletList items={asStringList(data.open_questions)} /></Section>
      <Section title="尽调事项"><BulletList items={asStringList(data.due_diligence_items)} /></Section>
    </div>
  );
}

function renderFounderMemory(data: Record<string, unknown>) {
  const fit = isObject(data.investor_fit) ? data.investor_fit : {};
  return (
    <div className="json-read-body">
      <div className="json-read-hero">
        <div>
          <p className="json-read-kicker">创业者私有记忆</p>
          <h3>{asString(data.summary) || "暂无摘要"}</h3>
        </div>
      </div>
      <KeyValueGrid rows={[
        { label: "Agent ID", value: asString(data.agent_id) },
        { label: "对方 ID", value: asString(data.counterparty_id) },
        { label: "建议跟进", value: asString(data.recommended_follow_up) },
        { label: "来源轮次", value: asStringList(data.source_turns).join("、") || null },
      ]} />
      <Section title="关键事实"><BulletList items={asStringList(data.key_facts)} /></Section>
      <Section title="未验证声明"><BulletList items={asStringList(data.unverified_claims)} /></Section>
      <FitBlock
        title="投资人匹配判断"
        score={asNumber(fit.score)}
        positive={asStringList(fit.positive_signals)}
        negative={asStringList(fit.negative_signals)}
      />
      <Section title="投资人关注点"><BulletList items={asStringList(data.investor_interests)} /></Section>
      <Section title="投资人顾虑"><BulletList items={asStringList(data.investor_concerns)} /></Section>
      <Section title="待确认问题"><BulletList items={asStringList(data.open_questions)} /></Section>
    </div>
  );
}

function renderDailyReport(data: Record<string, unknown>, role: "investor" | "founder" | null) {
  return (
    <div className="json-read-body">
      <div className="json-read-hero">
        <div>
          <p className="json-read-kicker">{role === "founder" ? "创业者工作日报" : role === "investor" ? "投资人工作日报" : "工作日报"}</p>
          <h3>{asString(data.headline) || asString(data.summary) || "暂无标题"}</h3>
        </div>
        {asString(data.date) ? <span className="json-read-date">{asString(data.date)}</span> : null}
      </div>
      {asString(data.summary) ? <p className="json-read-summary">{asString(data.summary)}</p> : null}
      <Section title="今日重点"><BulletList items={asStringList(data.priorities)} /></Section>
      {role === "investor"
        ? <Section title="关注清单"><BulletList items={asStringList(data.watchlist)} /></Section>
        : <Section title="投资人信号"><BulletList items={asStringList(data.investor_signals)} /></Section>}
      <Section title="跟进事项"><BulletList items={asStringList(data.follow_ups)} /></Section>
      <Section title="风险"><BulletList items={asStringList(data.risks)} /></Section>
      <Section title="引用的记忆"><BulletList items={asStringList(data.memory_used)} /></Section>
    </div>
  );
}

function renderGeneric(data: Record<string, unknown>) {
  const entries = Object.entries(data);
  if (!entries.length) return <p className="json-read-empty">空对象</p>;
  return (
    <div className="json-read-body">
      {entries.map(([key, value]) => {
        if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
          return (
            <Section key={key} title={key}>
              <BulletList items={asStringList(value)} />
            </Section>
          );
        }
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          return (
            <Section key={key} title={key}>
              <p className="json-read-summary">{String(value)}</p>
            </Section>
          );
        }
        return (
          <Section key={key} title={key}>
            <pre className="json-read-inline">{JSON.stringify(value, null, 2)}</pre>
          </Section>
        );
      })}
    </div>
  );
}

export type JsonDisplayKind =
  | "public_evaluation"
  | "investor_memory"
  | "founder_memory"
  | "investor_daily_report"
  | "founder_daily_report"
  | "generic";

export function JsonReadableView({ value, kind = "generic" }: { value: unknown; kind?: JsonDisplayKind }) {
  if (value === null || value === undefined) return <p className="json-read-empty">暂无内容</p>;
  if (!isObject(value)) return <pre className="json-read-inline">{JSON.stringify(value, null, 2)}</pre>;

  switch (kind) {
    case "public_evaluation":
      return renderPublicEvaluation(value);
    case "investor_memory":
      return renderInvestorMemory(value);
    case "founder_memory":
      return renderFounderMemory(value);
    case "investor_daily_report":
      return renderDailyReport(value, "investor");
    case "founder_daily_report":
      return renderDailyReport(value, "founder");
    default:
      if (value.memory_type === "investor_about_founder") return renderInvestorMemory(value);
      if (value.memory_type === "founder_about_investor") return renderFounderMemory(value);
      if (typeof value.match_score === "number" && typeof value.status === "string") return renderPublicEvaluation(value);
      if (typeof value.headline === "string" || typeof value.priorities !== "undefined") {
        return renderDailyReport(value, null);
      }
      return renderGeneric(value);
  }
}
