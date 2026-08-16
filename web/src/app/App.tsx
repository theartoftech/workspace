import {
  ArrowsClockwiseIcon,
  BellIcon,
  CaretDownIcon,
  ChartLineUpIcon,
  CheckCircleIcon,
  ClockIcon,
  CommandIcon,
  GearIcon,
  HardDrivesIcon,
  ListIcon,
  MagnifyingGlassIcon,
  PulseIcon,
  SquaresFourIcon,
  StackIcon,
  TerminalWindowIcon,
  WarningOctagonIcon,
  XIcon
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { MonitoringRequestError, createLiveMonitoringProvider } from "../data/provider";
import type { EnvironmentId, IncidentListResponse, MonitoringProvider, OverviewSnapshot, SessionResponse, TimeRange, WorkspaceRole } from "../data/types";
import {
  DeploymentsPage,
  IncidentsPage,
  InfrastructurePage,
  LogsPage,
  OverviewPage,
  PerformancePage,
  ServiceDetailPage,
  SettingsPage
} from "./pages";

interface NavigationItem {
  readonly label: string;
  readonly path: string;
  readonly icon: React.ComponentType<{ readonly size?: number; readonly "aria-hidden"?: boolean; readonly weight?: "fill" | "regular" }>;
}

const primaryNavigation: readonly NavigationItem[] = [
  { label: "Overview", path: "/", icon: SquaresFourIcon },
  { label: "Deployments", path: "/deployments", icon: StackIcon },
  { label: "Infrastructure", path: "/infrastructure", icon: HardDrivesIcon },
  { label: "Performance", path: "/performance", icon: ChartLineUpIcon },
  { label: "Incidents", path: "/incidents", icon: WarningOctagonIcon },
  { label: "Logs", path: "/logs", icon: TerminalWindowIcon },
  { label: "Settings", path: "/settings", icon: GearIcon }
];

const liveProvider = createLiveMonitoringProvider();

function CommandSearch({ onClose, services }: { readonly onClose: () => void; readonly services: OverviewSnapshot["services"] }): React.JSX.Element {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const commandItems = useMemo<readonly NavigationItem[]>(() => [
    ...primaryNavigation,
    ...services.map((service) => ({ label: service.name, path: `/services/${encodeURIComponent(service.id)}`, icon: PulseIcon }))
  ], [services]);
  const filtered = commandItems.filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function selectItem(path: string): void {
    void navigate(path);
    onClose();
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-label="Command search" onMouseDown={(event) => event.stopPropagation()}>
        <div className="command-input-row">
          <MagnifyingGlassIcon aria-hidden="true" size={20} />
          <input ref={inputRef} type="search" role="searchbox" placeholder="Search pages, services, and commands…" value={query} onChange={(event) => setQuery(event.target.value)} />
          <button className="icon-button" type="button" aria-label="Close command search" onClick={onClose}><XIcon aria-hidden="true" size={18} /></button>
        </div>
        <div className="command-results" role="listbox" aria-label="Search results">
          <span className="command-section-label">Navigate</span>
          {filtered.map((item) => {
            const Icon = item.icon;
            return (
              <button type="button" role="option" aria-selected="false" key={item.path} onClick={() => selectItem(item.path)}>
                <Icon aria-hidden={true} size={18} />
                <span>{item.label}</span>
                <kbd>↵</kbd>
              </button>
            );
          })}
          {filtered.length === 0 && <p className="command-empty">No matching pages or services.</p>}
        </div>
        <footer className="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>esc</kbd> close</span></footer>
      </section>
    </div>
  );
}

function Sidebar({ open, onClose, snapshot, activeIncidentCount }: { readonly open: boolean; readonly onClose: () => void; readonly snapshot: OverviewSnapshot | null; readonly activeIncidentCount: number | null }): React.JSX.Element {
  const sourceCount = snapshot?.sources.filter((source) => source.availability === "available").length ?? 0;
  return (
    <aside className={`sidebar ${open ? "sidebar-open" : ""}`} aria-label="Primary navigation">
      <div className="brand-row">
        <div className="brand-mark"><PulseIcon aria-hidden="true" size={22} weight="fill" /></div>
        <div><strong>Workspace</strong><span>Monitor</span></div>
        <button className="icon-button sidebar-close" type="button" aria-label="Close navigation" onClick={onClose}><XIcon aria-hidden="true" size={19} /></button>
      </div>
      <div className="tenant-block">
        <span className="tenant-avatar">DL</span>
        <div><strong>Development Lab</strong><span>Enterprise workspace</span></div>
        <CaretDownIcon aria-hidden="true" size={14} />
      </div>
      <nav className="primary-nav">
        <span className="nav-section-label">OPERATIONS</span>
        {primaryNavigation.slice(0, 6).map((item) => {
          const Icon = item.icon;
          return (
            <NavLink key={item.path} to={item.path} end={item.path === "/"} aria-label={item.label} onClick={onClose}>
              {({ isActive }) => <><Icon aria-hidden={true} size={19} weight={isActive ? "fill" : "regular"} /><span>{item.label}</span>{item.label === "Incidents" && activeIncidentCount !== null && activeIncidentCount > 0 && <b aria-hidden="true">{activeIncidentCount}</b>}</>}
            </NavLink>
          );
        })}
        <span className="nav-section-label governance-label">GOVERNANCE</span>
        {primaryNavigation.slice(6).map((item) => {
          const Icon = item.icon;
          return <NavLink key={item.path} to={item.path} aria-label={item.label} onClick={onClose}>{({ isActive }) => <><Icon aria-hidden={true} size={19} weight={isActive ? "fill" : "regular"} /><span>{item.label}</span></>}</NavLink>;
        })}
      </nav>
      <div className="sidebar-status">
        <div><span className="status-light" aria-hidden="true" /><strong>{snapshot?.mode === "partial" ? "Collectors partial" : "Collectors operational"}</strong></div>
        <span>{snapshot ? `${sourceCount}/${snapshot.sources.length} sources available` : "Checking sources"}</span>
      </div>
    </aside>
  );
}

function LoadingShell(): React.JSX.Element {
  return (
    <div className="loading-shell" aria-label="Loading monitoring overview" aria-live="polite">
      <div className="skeleton skeleton-title" />
      <div className="skeleton-grid">{[1, 2, 3, 4].map((item) => <div className="skeleton skeleton-card" key={item} />)}</div>
      <div className="skeleton skeleton-panel" />
    </div>
  );
}

function ErrorShell({ message }: { readonly message: string }): React.JSX.Element {
  return <section className="error-shell" role="alert"><WarningOctagonIcon aria-hidden="true" size={28} /><h1>Monitoring shell unavailable</h1><p>{message}</p></section>;
}

function AuthenticationShell({ status, message, returnTo }: { readonly status: number; readonly message: string; readonly returnTo: string }): React.JSX.Element {
  const anonymous = status === 401;
  return (
    <main className="authentication-shell" id="main-content">
      <section className="error-shell" role="alert">
        <WarningOctagonIcon aria-hidden="true" size={28} />
        <h1>{anonymous ? "Authentication required" : status === 503 ? "Identity provider unavailable" : "Authentication unavailable"}</h1>
        <p>{message}</p>
        {anonymous && <a className="primary-button" href={`/auth/login?returnTo=${encodeURIComponent(returnTo)}`}>Sign in</a>}
      </section>
    </main>
  );
}

function displayRole(role: WorkspaceRole): string {
  return role === "administrator" ? "Administrator" : role === "operator" ? "Operator" : "Viewer";
}

function userInitials(displayName: string): string {
  const initials = displayName.trim().split(/\s+/u).slice(0, 2).map((part) => part.at(0)?.toUpperCase() ?? "").join("");
  return initials === "" ? "?" : initials;
}

export function App({ provider = liveProvider }: { readonly provider?: MonitoringProvider }): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const [environment, setEnvironment] = useState<EnvironmentId>("all");
  const [timeRange, setTimeRange] = useState<TimeRange>(() => {
    const requested = new URLSearchParams(location.search).get("range");
    return requested === "15m" || requested === "1h" || requested === "6h" || requested === "24h" ? requested : "1h";
  });
  const [snapshot, setSnapshot] = useState<OverviewSnapshot | null>(null);
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [authenticationFailure, setAuthenticationFailure] = useState<{ readonly status: number; readonly message: string } | null>(null);
  const [activeIncidents, setActiveIncidents] = useState<IncidentListResponse | null>(null);
  const [incidentError, setIncidentError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [operatorOpen, setOperatorOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [incidentRefreshKey, setIncidentRefreshKey] = useState(0);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  useEffect(() => {
    let active = true;
    setSession(null);
    setAuthenticationFailure(null);
    void provider.getSession().then((response) => {
      if (active) setSession(response);
    }).catch((cause: unknown) => {
      if (!active) return;
      setAuthenticationFailure({
        status: cause instanceof MonitoringRequestError ? cause.status : 0,
        message: cause instanceof Error ? cause.message : "The authenticated session could not be validated."
      });
    });
    return () => { active = false; };
  }, [provider]);

  useEffect(() => {
    if (session === null) return;
    let active = true;
    setSnapshot(null);
    setError(null);
    provider.getOverview(environment, timeRange)
      .then((nextSnapshot) => {
        if (active) setSnapshot(nextSnapshot);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Unknown monitoring provider error");
      });
    return () => { active = false; };
  }, [environment, provider, session, timeRange]);

  useEffect(() => {
    if (session === null) return;
    let active = true;
    if (provider.getIncidents === undefined) {
      setActiveIncidents(null);
      setIncidentError("Persistent incident operations are not configured.");
      return () => { active = false; };
    }
    setIncidentError(null);
    void provider.getIncidents(environment, "active")
      .then((response) => { if (active) setActiveIncidents(response); })
      .catch((cause: unknown) => {
        if (active) { setActiveIncidents(null); setIncidentError(cause instanceof Error ? cause.message : "Unknown incident provider error"); }
      });
    return () => { active = false; };
  }, [environment, incidentRefreshKey, provider, session]);

  function refreshMonitoringData(): void {
    if (session === null) return;
    setRefreshKey((value) => value + 1);
    setIncidentRefreshKey((value) => value + 1);
    setRefreshedAt(new Date());
    setError(null);
    void provider.getOverview(environment, timeRange)
      .then((nextSnapshot) => setSnapshot(nextSnapshot))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Unknown monitoring provider error"));
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT";
      if (event.key === "/" && !isTyping) {
        event.preventDefault();
        setCommandOpen(true);
      }
      if (event.key === "Escape") {
        setCommandOpen(false);
        setAlertsOpen(false);
        setOperatorOpen(false);
        setSidebarOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  const routeSnapshot = useMemo<OverviewSnapshot | null>(() => snapshot, [snapshot]);
  const returnTo = `${location.pathname}${location.search}`;

  if (authenticationFailure !== null) {
    return <AuthenticationShell status={authenticationFailure.status} message={authenticationFailure.message} returnTo={returnTo} />;
  }
  if (session === null) {
    return <main className="authentication-shell" id="main-content"><LoadingShell /></main>;
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to monitoring content</a>
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} snapshot={snapshot} activeIncidentCount={activeIncidents?.summary.active ?? null} />
      {sidebarOpen && <button className="sidebar-scrim" type="button" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
      <div className="workspace">
        <header className="topbar">
          <button className="icon-button mobile-menu" type="button" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}><ListIcon aria-hidden="true" size={21} /></button>
          <button className="search-trigger" type="button" onClick={() => setCommandOpen(true)}>
            <MagnifyingGlassIcon aria-hidden="true" size={17} />
            <span>Search workspace</span>
            <kbd><CommandIcon aria-hidden="true" size={12} /> K</kbd>
          </button>
          <div className="topbar-controls">
            <label className="select-control"><span className="sr-only">Environment</span><select value={environment} onChange={(event) => setEnvironment(event.target.value as EnvironmentId)}><option value="demo">Demo / Prod</option><option value="test">Test</option><option value="portfolio">Portfolio</option><option value="all">Shared (all)</option></select><CaretDownIcon aria-hidden="true" size={13} /></label>
            <label className="select-control time-control"><ClockIcon aria-hidden="true" size={15} /><span className="sr-only">Time range</span><select value={timeRange} onChange={(event) => setTimeRange(event.target.value as TimeRange)}><option value="15m">Last 15 min</option><option value="1h">Last 1 hour</option><option value="6h">Last 6 hours</option><option value="24h">Last 24 hours</option></select><CaretDownIcon aria-hidden="true" size={13} /></label>
            <div className="refresh-control">
              <button className="icon-button" type="button" aria-label="Refresh monitoring data" onClick={refreshMonitoringData}><ArrowsClockwiseIcon aria-hidden="true" size={18} /></button>
              {refreshedAt !== null && <span aria-live="polite">Refreshed {refreshedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>}
            </div>
            <div className="popover-anchor">
              <button className="icon-button notification-button" type="button" aria-label={`Open alerts, ${activeIncidents?.summary.active ?? 0} active`} aria-expanded={alertsOpen} onClick={() => setAlertsOpen((value) => !value)}><BellIcon aria-hidden="true" size={20} />{(activeIncidents?.summary.active ?? 0) > 0 && <span>{activeIncidents?.summary.active}</span>}</button>
              {alertsOpen && <div className="utility-popover alerts-popover"><strong>Active alerts</strong>{incidentError !== null ? <p>{incidentError}</p> : activeIncidents === null ? <p>Loading incidents…</p> : activeIncidents.incidents.length === 0 ? <p>No active incidents.</p> : activeIncidents.incidents.slice(0, 5).map((incident) => <button type="button" key={incident.id} onClick={() => { setAlertsOpen(false); void navigate("/incidents"); }}><span className={`alert-dot alert-dot-${incident.severity === "P1" ? "critical" : "warning"}`} />{incident.title}<small>{incident.serviceName} · {incident.severity}</small></button>)}</div>}
            </div>
            <div className="popover-anchor operator-anchor">
              <button className="operator-button" type="button" aria-label="Open operator menu" aria-expanded={operatorOpen} onClick={() => setOperatorOpen((value) => !value)}><span>{userInitials(session.user.displayName)}</span><div><strong>{session.user.displayName}</strong><small>{displayRole(session.user.role)}</small></div><CaretDownIcon aria-hidden="true" size={13} /></button>
              {operatorOpen && <div className="utility-popover operator-popover"><button type="button">Operator profile</button><button type="button">Keyboard shortcuts</button><form method="post" action="/auth/logout"><button type="submit">Sign out</button></form></div>}
            </div>
          </div>
        </header>
        <div className={`fixture-banner data-banner-${snapshot?.mode ?? "loading"}`} role="status">
          <span>{snapshot?.mode === "partial" ? <WarningOctagonIcon aria-hidden="true" size={15} weight="fill" /> : <CheckCircleIcon aria-hidden="true" size={15} weight="fill" />}{snapshot?.mode === "fixture" ? "Fixture data" : snapshot?.mode === "partial" ? "Partial live inventory" : snapshot?.mode === "live" ? "Live inventory" : "Loading inventory"}</span>
          <p>{snapshot?.mode === "fixture"
            ? "This test shell uses deterministic Sprint 1 data."
            : snapshot?.mode === "partial"
              ? "Available sources stay live and unavailable sources are explicit. Persistent incidents retain their independent source status."
              : "Inventory, performance, topology, persistent incidents, and redacted log correlation use live server APIs."}</p>
          <small>{snapshot ? `Snapshot ${new Date(snapshot.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Loading snapshot"}</small>
        </div>
        <main id="main-content" tabIndex={-1}>
          {error ? <ErrorShell message={error} /> : routeSnapshot ? (
            <Routes>
              <Route path="/" element={<OverviewPage snapshot={routeSnapshot} />} />
              <Route path="/services/:serviceId" element={<ServiceDetailPage snapshot={routeSnapshot} timeRange={timeRange} />} />
              <Route path="/deployments" element={<DeploymentsPage snapshot={routeSnapshot} />} />
              <Route path="/infrastructure" element={<InfrastructurePage snapshot={routeSnapshot} provider={provider} environment={environment} refreshKey={refreshKey} />} />
              <Route path="/performance" element={<PerformancePage snapshot={routeSnapshot} provider={provider} timeRange={timeRange} refreshKey={refreshKey} />} />
              <Route path="/incidents" element={<IncidentsPage snapshot={routeSnapshot} provider={provider} environment={environment} timeRange={timeRange} refreshKey={incidentRefreshKey} role={session.user.role} onMutated={() => setIncidentRefreshKey((value) => value + 1)} />} />
              <Route path="/logs" element={<LogsPage snapshot={routeSnapshot} provider={provider} timeRange={timeRange} refreshKey={refreshKey} />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<ErrorShell message="The requested monitoring route does not exist." />} />
            </Routes>
          ) : <LoadingShell />}
        </main>
      </div>
      {commandOpen && <CommandSearch onClose={() => setCommandOpen(false)} services={snapshot?.services ?? []} />}
    </div>
  );
}
