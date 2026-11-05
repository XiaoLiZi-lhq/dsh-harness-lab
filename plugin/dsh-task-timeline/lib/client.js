/**
 * dsh-task-timeline client half: registers the 任务时间线 tab in
 * dsh-better-sidebar. Shipped in the web shell's __ModuleLoader__ format.
 */
window.__ModuleLoader__.load({
	id: "dsh-task-timeline",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		const { useState, useEffect, useCallback, createElement: h } = React;

		const inject = ["betterSidebar", "sessions"];

		const STATUS_COLOR = { completed: "var(--dsh-ok, #34c77b)", in_progress: "var(--dsh-accent, #4d6bfe)", pending: "var(--dsh-dim, #9a9a9a)" };
		const STATUS_GLYPH = { completed: "✓", in_progress: "◐", pending: "○" };

		function fmtTime(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
			const d = new Date(ms);
			const pad = (n) => String(n).padStart(2, "0");
			return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		}

		function TodoRow({ item }) {
			return h("div", { style: { display: "flex", gap: 6, alignItems: "flex-start", padding: "2px 0", fontSize: 12, lineHeight: 1.4 } },
				h("span", { style: { color: STATUS_COLOR[item.status], flexShrink: 0, width: 14 } }, STATUS_GLYPH[item.status]),
				h("span", { style: { color: item.status === "pending" ? "var(--dsh-dim, #9a9a9a)" : "inherit", textDecoration: item.status === "completed" ? "line-through" : "none" } }, item.content));
		}

		function SnapshotCard({ snap, onFork, forkingSeq }) {
			const done = snap.todos.filter((t) => t.status === "completed").length;
			return h("div", { style: { border: "1px solid var(--dsh-border, #2e2e2e)", borderRadius: 8, padding: "8px 10px", marginBottom: 8, background: "var(--dsh-surface, #1c1c1c)" } },
				h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 4 } },
					h("span", { style: { fontSize: 11, color: "var(--dsh-dim, #9a9a9a)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }, title: snap.prompt },
						`T${snap.turn} · ${fmtTime(snap.time)} · ${done}/${snap.todos.length}`),
					h("button", {
						onClick: () => onFork(snap),
						disabled: forkingSeq !== null,
						title: "分叉回退到这个任务清单所在的回合（磁盘文件不回滚）",
						style: { fontSize: 11, padding: "2px 8px", borderRadius: 6, cursor: "pointer", border: "1px solid var(--dsh-border, #3a3a3a)", background: "transparent", color: "var(--dsh-fg, #eee)" },
					}, forkingSeq === snap.seq ? "分叉中…" : "⟲ 回到这里")),
				snap.prompt ? h("div", { style: { fontSize: 11, color: "var(--dsh-dim, #8a8a8a)", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, `需求：${snap.prompt}`) : null,
				h("div", null, snap.todos.slice(0, 8).map((t, i) => h(TodoRow, { key: i, item: t })),
					snap.todos.length > 8 ? h("div", { style: { fontSize: 11, color: "var(--dsh-dim, #8a8a8a)" } }, `…共 ${snap.todos.length} 项`) : null));
		}

		function TaskTimelineTab(props) {
			const { ctx, scope, visible } = props;
			// Everything shown is tagged with the sessionId it belongs to: a
			// stale poll answer or a session switch can never paint another
			// session's list (or fork its seqs) under the current one.
			const [state, setState] = useState(null); // { sessionId, data, loadError }
			const [forkError, setForkError] = useState(null);
			const [forkingSeq, setForkingSeq] = useState(null);
			const [showHistory, setShowHistory] = useState(true);
			const live = state !== null && state.sessionId === scope.sessionId ? state : null;
			const data = live?.data ?? null;
			const loadError = live?.loadError ?? null;

			const load = useCallback(async (signal) => {
				const requested = scope.sessionId;
				try {
					const res = await fetch("/task-timeline/api/history", {
						method: "POST", credentials: "same-origin", signal,
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId: requested }),
					});
					const json = await res.json();
					if (!json.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
					setState({ sessionId: requested, data: json, loadError: null });
				} catch (e) {
					if (e?.name === "AbortError") return;
					const message = String(e?.message ?? e);
					// Keep the previous payload of the SAME session (soft
					// degradation); a different session's data is dropped.
					setState((prev) => ({
						sessionId: requested,
						data: prev?.sessionId === requested ? (prev?.data ?? null) : null,
						loadError: message,
					}));
				}
			}, [scope.sessionId]);

			useEffect(() => {
				if (!visible) return;
				const ctrl = new AbortController();
				void load(ctrl.signal);
				// The poll shares the SAME signal, so cleanup aborts in-flight
				// polls too — a late answer from an old session can never land.
				const timer = setInterval(() => { void load(ctrl.signal); }, 15000);
				return () => { ctrl.abort(); clearInterval(timer); };
			}, [visible, load]);

			const onFork = useCallback(async (snap) => {
				setForkingSeq(snap.seq);
				setForkError(null);
				const sessions = ctx.get("sessions");
				try {
					if (!sessions || typeof sessions.fork !== "function") {
						throw new Error("sessions 服务不可用（宿主未提供分叉能力）");
					}
					const child = await sessions.fork({ sessionId: scope.sessionId, atSeq: snap.seq, increaseTitle: true });
					// Opening the child is a separate outcome from forking: the
					// session already exists on disk, so an open failure must
					// not be reported as "fork failed" (invites duplicate forks).
					try {
						if (typeof sessions.open === "function") sessions.open(child);
					} catch (e) {
						setForkError(`分叉已创建，但打开新会话失败：${String(e?.message ?? e)}`);
					}
				} catch (e) {
					setForkError(`分叉失败：${String(e?.message ?? e)}`);
				} finally {
					setForkingSeq(null);
				}
			}, [ctx, scope.sessionId]);

			if (loadError !== null && data === null) {
				return h("div", { style: { padding: 12, fontSize: 12, color: "var(--dsh-danger, #e5484d)" } },
					h("div", { style: { marginBottom: 8 } }, `加载失败：${loadError}`),
					h("button", {
						onClick: () => void load(),
						style: { fontSize: 11, padding: "2px 10px", borderRadius: 6, cursor: "pointer", border: "1px solid var(--dsh-border, #3a3a3a)", background: "transparent", color: "var(--dsh-fg, #eee)" },
					}, "↻ 重试"));
			}
			if (data === null) return h("div", { style: { padding: 12, fontSize: 12, color: "var(--dsh-dim, #9a9a9a)" } }, "加载中…");

			const history = [...(data.snapshots ?? [])].reverse().filter((s) => s && s.seq != null);
			return h("div", { style: { padding: 10, height: "100%", overflowY: "auto", boxSizing: "border-box" } },
				forkError !== null ? h("div", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--dsh-danger, #e5484d)", marginBottom: 8 } },
					h("span", { style: { flex: 1 } }, forkError),
					h("button", { onClick: () => setForkError(null), style: { background: "transparent", color: "inherit", border: "none", cursor: "pointer", fontSize: 13 }, title: "关闭" }, "×")) : null,
				loadError !== null ? h("div", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--dsh-danger, #e5484d)", marginBottom: 8 } },
					h("span", { style: { flex: 1 } }, `刷新失败：${loadError}`),
					h("button", { onClick: () => void load(), style: { background: "transparent", color: "inherit", border: "none", cursor: "pointer", fontSize: 12 }, title: "重试" }, "↻"),
					h("button", { onClick: () => setState((prev) => (prev?.sessionId === scope.sessionId ? { ...prev, loadError: null } : prev)), style: { background: "transparent", color: "inherit", border: "none", cursor: "pointer", fontSize: 13 }, title: "关闭" }, "×")) : null,
				h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
					h("strong", { style: { fontSize: 13 } }, "当前任务"),
					h("button", { onClick: () => void load(), style: { fontSize: 11, background: "transparent", color: "var(--dsh-dim, #9a9a9a)", border: "none", cursor: "pointer" } }, "↻ 刷新")),
				data.current.length === 0 ? h("div", { style: { fontSize: 12, color: "var(--dsh-dim, #9a9a9a)", marginBottom: 10 } }, "（暂无任务清单）") :
					h("div", { style: { marginBottom: 12 } }, data.current.map((t, i) => h(TodoRow, { key: i, item: t }))),
				h("div", { onClick: () => setShowHistory(!showHistory), style: { cursor: "pointer", fontSize: 12, fontWeight: 600, marginBottom: 6, userSelect: "none" } },
					`历史任务（${history.length}）${showHistory ? " ▾" : " ▸"}`),
				showHistory ? (history.length === 0 ? h("div", { style: { fontSize: 12, color: "var(--dsh-dim, #9a9a9a)" } }, "（会话中还没有 todo_write 记录）") :
					history.map((s) => h(SnapshotCard, { key: s.seq, snap: s, onFork, forkingSeq }))) : null,
				h("div", { style: { marginTop: 8, fontSize: 10.5, color: "var(--dsh-dim, #777)", lineHeight: 1.5 } },
					"⟲ = 从该回合分叉新会话（对话回退；磁盘文件不回滚）"));
		}

		function TabIcon(size) {
			return h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none" },
				h("path", { d: "M2.5 4h2M2.5 8h2M2.5 12h2M7 4h6.5M7 8h6.5M7 12h4", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" }));
		}

		function apply(ctx) {
			const sidebar = ctx.get("betterSidebar");
			if (sidebar === undefined) {
				console.warn("[dsh-task-timeline] betterSidebar service unavailable; tab not registered");
				return;
			}
			const register = () => sidebar.registerTab({
				id: "task-timeline",
				title: "任务时间线",
				icon: TabIcon,
				order: 55,
				single: true,
				component: TaskTimelineTab,
			});
			// Hang the registration on the plugin fiber when the runtime offers
			// ctx.effect, so an unload/reload disposes the tab (registering the
			// same id twice throws inside better-sidebar).
			if (typeof ctx?.effect === "function") {
				ctx.effect(register, "dsh-task-timeline: task-timeline tab");
			} else {
				register();
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
