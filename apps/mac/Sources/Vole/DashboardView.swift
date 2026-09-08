import SwiftUI
import AppKit
import Charts
import ServiceManagement

/// One chip per collector: green fresh, amber stale with its last-seen time, grey
/// "no artifacts on this Mac", red error. The states come from the collector's own
/// heartbeat rows, not from which files happen to have been touched.
struct CoverageStrip: View {
    let heartbeats: [CollectorHeartbeat]

    var body: some View {
        if heartbeats.isEmpty {
            Label("No collector pass recorded yet", systemImage: "questionmark.circle")
                .font(.caption).foregroundStyle(.secondary)
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(heartbeats) { hb in
                        chip(hb)
                    }
                }
                .padding(.vertical, 1)
            }
        }
    }

    @ViewBuilder
    private func chip(_ hb: CollectorHeartbeat) -> some View {
        let fresh = Date(timeIntervalSince1970: Double(hb.startedAt) / 1000)
            .timeIntervalSinceNow > -120   // two poll cadences, generously
        let state: CoverageState =
            hb.sourceState == "error" ? .error :
            hb.sourceState == "no_source" ? .absent :
            fresh ? .fresh : .stale
        HStack(spacing: 4) {
            Circle().fill(state.color).frame(width: 7, height: 7)
            Text(Labels.toolShort[hb.tool] ?? hb.tool)
        }
        .font(.caption)
        .padding(.horizontal, 8).padding(.vertical, 3)
        .background(state.color.opacity(0.12), in: Capsule())
        .foregroundStyle(.primary)
        .help(hb.sourceState == "no_source"
              ? "No \(Labels.tool[hb.tool] ?? hb.tool) artifacts on this Mac (last looked \(Fmt.rel(hb.startedAt)))"
              : "\(Labels.tool[hb.tool] ?? hb.tool): last pass \(Fmt.rel(hb.startedAt)), \(hb.durationMs)ms, \(hb.files) files, \(hb.parsed) parsed\(state.isStale ? " — STALE" : "")")
    }

    enum CoverageState {
        case fresh, absent, error, stale
        var color: Color {
            switch self {
            case .fresh: .green
            case .absent: .secondary
            case .error: .red
            case .stale: .orange
            }
        }
        var isStale: Bool { if case .stale = self { true } else { false } }
    }
}

// MARK: - Incident-annotated timeline
private struct Mark: Identifiable {
    let bucket: Int, severity: String, count: Int
    var id: Int { bucket }
}

private func marks(_ incidents: [Incident], _ bucketMs: Int) -> [Mark] {
    let rank = ["info": 0, "warn": 1, "critical": 2]
    let name = ["info", "warn", "critical"]
    var by: [Int: (sev: Int, n: Int)] = [:]
    for i in incidents {
        let b = i.bucket(bucketMs)
        let cur = by[b] ?? (0, 0)
        by[b] = (max(cur.sev, rank[i.severity] ?? 0), cur.n + 1)
    }
    return by.map { Mark(bucket: $0.key, severity: name[$0.value.sev], count: $0.value.n) }
}

struct TimelineChart: View {
    let series: [TimePoint]
    let incidents: [Incident]
    let bucketMs: Int
    @Binding var selectedDate: Date?
    /// Fired when the user picks a bucket via the incident lane (not the bars):
    /// the parent jumps to the Incidents list filtered to that bucket.
    var onPickIncident: ((Int) -> Void)?

    private var unit: Calendar.Component { bucketMs == 3_600_000 ? .hour : .day }
    private var xLabelFormat: Date.FormatStyle {
        bucketMs == 3_600_000 ? .dateTime.hour() : .dateTime.month(.abbreviated).day()
    }
    private var selectedBucket: Int? {
        selectedDate.map { (Int($0.timeIntervalSince1970 * 1000) / bucketMs) * bucketMs }
    }
    private var incidentMarks: [Mark] { marks(incidents, bucketMs) }
    private var yMax: Double { Double(max(series.map(\.total).max() ?? 1, 1)) }

    /// Tools with any tokens in the visible range, plus their range total, biggest
    /// first — drives the stack order, the shade ramp and the logo strip.
    /// The domain is the DATA (whatever tools the store actually holds), never a
    /// hard-coded list: a new collector's tool renders with a fallback label the
    /// day it first writes a row, without an app change.
    private var toolTotals: [(tool: String, tokens: Int)] {
        var totals: [String: Int] = [:]
        for p in series {
            for (t, v) in p.tokensByTool where v > 0 {
                totals[t, default: 0] += v
            }
        }
        return totals.map { (tool: $0.key, tokens: $0.value) }.sorted { $0.tokens > $1.tokens }
    }

    // One brand colour per agent (see Pal.series) so a bar segment matches that tool's
    // swatch and logo in the strip below.
    private var agentDomain: [String] { toolTotals.map { Labels.tool[$0.tool] ?? $0.tool } }
    private var agentRange: [Color] { toolTotals.map { Pal.series($0.tool) } }

    private var selection: (bucket: Int, date: Date, total: Int, incidents: Int)? {
        guard let b = selectedBucket,
              let pt = series.first(where: { $0.bucket == b }), pt.total > 0 else { return nil }
        return (b, Date(timeIntervalSince1970: Double(b) / 1000), pt.total,
                incidentMarks.first { $0.bucket == b }?.count ?? 0)
    }

    // Stacked per agent in that agent's brand colour; biggest agent at the base.
    // The logo strip below is the key.
    @ChartContentBuilder private var barMarks: some ChartContent {
        ForEach(series, id: \.bucket) { p in
            ForEach(toolTotals, id: \.tool) { row in
                let v = p.tokensByTool[row.tool] ?? 0
                if v > 0 {
                    BarMark(x: .value("Time", p.date, unit: unit), y: .value("Tokens", v))
                        .cornerRadius(3)
                        .foregroundStyle(by: .value("Agent", Labels.tool[row.tool] ?? row.tool))
                }
            }
        }
        // Incident marks, drawn at the plot base beneath the bars: one per bucket,
        // in severity colour, sized by how many fired there. README promised these
        // for a year while marks() fed only the hover count.
        ForEach(incidentMarks) { m in
            PointMark(x: .value("Time", Date(timeIntervalSince1970: Double(m.bucket + bucketMs / 2) / 1000), unit: unit),
                      y: .value("Tokens", 0))
                .foregroundStyle(Pal.severity(m.severity))
                .symbolSize(CGFloat(30 + min(m.count, 4) * 25))
        }
    }

    @ChartContentBuilder private var selectionMark: some ChartContent {
        if let s = selection {
            // Centre on the bar (bucket start + half a bucket); no `unit:` so the rule
            // stays a hairline instead of widening into a band over the bar.
            let mid = Date(timeIntervalSince1970: (Double(s.bucket) + Double(bucketMs) / 2) / 1000)
            RuleMark(x: .value("Time", mid))
                .foregroundStyle(.secondary.opacity(0.3))
                .lineStyle(StrokeStyle(lineWidth: 1))
            // Invisible anchor for the callout. Cap it well below the plot ceiling so
            // there's always room for the callout above it — otherwise overflow
            // resolution squashes it into a textless sliver over a tall bar.
            PointMark(x: .value("Time", mid),
                      y: .value("Tokens", min(Double(s.total), yMax * 0.6)))
                .opacity(0)
                .annotation(position: .top, spacing: 8,
                            overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .plot))) {
                    callout(s)
                }
        }
    }

    @ViewBuilder
    private func callout(_ s: (bucket: Int, date: Date, total: Int, incidents: Int)) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(Fmt.clock(s.bucket)).font(.caption2).foregroundStyle(.secondary)
                Text("\(Fmt.compact(s.total)) tokens")
                    .font(.footnote.weight(.semibold)).monospacedDigit()
            }
            if s.incidents > 0 {
                Divider().frame(height: 20)
                Label("\(s.incidents)", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption2).foregroundStyle(.orange)
            }
        }
        .fixedSize()
        .padding(.horizontal, 10).padding(.vertical, 7)
        // `.glassEffect` renders as an empty block inside a Charts annotation — use a
        // plain material tooltip here.
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(.quaternary, lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.22), radius: 6, y: 2)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Chart {
                barMarks
                selectionMark
            }
            .chartForegroundStyleScale(domain: agentDomain, range: agentRange)
            .chartLegend(.hidden)   // the logo strip below is the key
            .chartYScale(domain: 0 ... yMax * 1.15)   // headroom for the selection callout
            .chartXSelection(value: $selectedDate)
            .chartXAxis { xAxis }
            .chartYAxis {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) {
                    AxisGridLine().foregroundStyle(.quaternary.opacity(0.4))
                    AxisValueLabel(format: IntegerFormatStyle<Int>().notation(.compactName))
                        .font(.caption2)
                }
            }
            .frame(height: 200)
            .padding(.top, 10)

            incidentLane

            logoStrip
        }
    }

    /// The explicit x-domain shared by the chart and the lane, so the lane's ticks
    /// line up with the bars above them to the pixel.
    private var xDomain: ClosedRange<Date> {
        let lo = series.first?.date ?? .distantPast
        let hi = series.last?.date ?? .distantFuture
        return lo...hi
    }

    /// A thin incident lane under the plot: severity-coloured ticks on the same time
    /// axis. Picking one jumps to the Incidents list filtered to that bucket.
    @ViewBuilder
    private var incidentLane: some View {
        if !incidentMarks.isEmpty {
            Chart(incidentMarks) { m in
                PointMark(x: .value("Time", Date(timeIntervalSince1970: Double(m.bucket + bucketMs / 2) / 1000), unit: unit),
                          y: .value("Incidents", 0))
                    .foregroundStyle(Pal.severity(m.severity))
                    .symbol(.circle)
                    .symbolSize(CGFloat(40 + min(m.count, 4) * 20))
            }
            .chartXScale(domain: xDomain)
            .chartYScale(domain: -1 ... 1)
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartLegend(.hidden)
            .frame(height: 18)
            .chartXSelection(value: Binding(
                get: { selectedDate },
                set: { d in
                    guard let d else { return }
                    selectedDate = d
                    onPickIncident?((Int(d.timeIntervalSince1970 * 1000) / bucketMs) * bucketMs)
                }
            ))
            .help("Incidents in this range — click a mark to see them")
        }
    }

    /// Key for the stack: brand swatch + logo + range total, biggest share first.
    private var logoStrip: some View {
        HStack(spacing: 16) {
            ForEach(toolTotals, id: \.tool) { row in
                HStack(spacing: 5) {
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(Pal.series(row.tool))
                        .frame(width: 9, height: 9)
                    ToolIcon(tool: row.tool, size: 14)
                    Text(Labels.toolShort[row.tool] ?? row.tool)
                        .font(.caption).foregroundStyle(.secondary)
                    Text(Fmt.compact(row.tokens))
                        .font(.caption).monospacedDigit().foregroundStyle(.tertiary)
                }
            }
            Spacer(minLength: 0)
        }
    }

    @AxisContentBuilder private var xAxis: some AxisContent {
        if bucketMs == 3_600_000 {
            // 24h: a label every 6 hours.
            AxisMarks(values: .stride(by: .hour, count: 6)) {
                AxisValueLabel(format: xLabelFormat, anchor: .top).font(.caption2)
            }
        } else {
            // 7d / 30d / all: let Charts pick ~5 nicely-spaced dates so labels never pile up.
            AxisMarks(values: .automatic(desiredCount: 5)) {
                AxisValueLabel(format: xLabelFormat, anchor: .top).font(.caption2)
            }
        }
    }
}

// MARK: - Navigation

enum SidebarGroup: String, CaseIterable, Identifiable {
    case monitor = "Monitor"
    case risk     = "Risk"
    case manage   = "Manage"
    var id: String { rawValue }
}

enum DashSection: String, CaseIterable, Identifiable {
    case dashboard = "Dashboard"
    case breakdown = "Breakdown"
    case incidents = "Incidents"
    case triage    = "Triage"
    case shadowAI  = "Shadow AI"
    case posture   = "Posture"
    case behaviour  = "Behaviour"
    case blast     = "Blast Radius"     // tier 5 #17: between Behaviour and Data Exposure
    case exposure   = "Data Exposure"
    case people    = "People"
    case privacy   = "Privacy"
    case settings  = "Settings"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .dashboard: return "square.grid.2x2"
        case .breakdown: return "square.stack.3d.up"
        case .incidents: return "exclamationmark.triangle"
        case .triage:    return "checklist"
        case .exposure:  return "shield.checkered"
        case .shadowAI:  return "sparkle.magnifyingglass"
        case .posture:   return "checkmark.shield"
        case .blast:     return "circle.dashed"
        case .behaviour: return "waveform.path"
        case .people:    return "person.2"
        case .privacy:   return "hand.raised"
        case .settings:  return "gearshape"
        }
    }
    /// The backing table(s) this section needs. Probed once per launch: a section
    /// whose table is absent (an older store, a collector that predates it) still
    /// appears and names what is missing — never an empty list pretending to be a
    /// finding. nil means the section needs nothing beyond the store itself.
    var requires: [String]? {
        switch self {
        case .dashboard, .breakdown, .settings: return nil
        case .incidents: return ["v_incident_explained"]
        case .triage:    return ["finding_actions"]
        case .shadowAI:  return ["ai_surfaces"]
        case .posture:   return ["grants"]
        case .exposure: return ["secret_sightings"]          // Tier 4 ledger
        case .behaviour: return ["tool_calls"]               // Tier 5 ledger
        case .blast:     return ["action_targets"]           // Tier 5 target ledger
        case .people:    return ["principals"]
        case .privacy:   return nil
        }
    }

    /// The required tables this store does not have (probed against Store's set).
    func missingTables(available: Set<String>) -> [String]? {
        guard let needs = requires, !needs.isEmpty else { return nil }
        let missing = needs.filter { !available.contains($0) }
        return missing.isEmpty ? nil : missing
    }

    /// Which tier's collector writes the missing table, for the unavailable state.
    var arrivesWith: String {
        switch self {
        case .posture: return "Tier 6 — the posture & supply-chain collectors"
        case .exposure: return "Tier 4 — the DLP scanner"
        case .behaviour, .blast: return "Tier 5 — the tool-call ledger"
        case .people: return "Tier 3 — the identity seam"
        default: return "a later collector version"
        }
    }
    var group: SidebarGroup {
        switch self {
        case .dashboard, .breakdown: return .monitor
        case .incidents, .triage, .shadowAI, .posture, .behaviour, .blast, .exposure: return .risk
        case .people, .privacy, .settings: return .manage
        }
    }
    static func inGroup(_ g: SidebarGroup) -> [DashSection] {
        allCases.filter { $0.group == g }
    }

    /// One COUNT per section, refreshed on the existing Store poll.
    func badge(counts: SectionCounts) -> Int {
        switch self {
        case .incidents: return counts.incidents
        case .triage: return counts.untriaged
        case .shadowAI: return counts.surfaces
        default: return 0
        }
    }
}

/// The per-section COUNTs, computed once per Store poll — never per render.
@MainActor
struct SectionCounts {
    var incidents = 0
    var untriaged = 0
    var surfaces = 0
    static func compute(_ store: Store) -> SectionCounts {        var c = SectionCounts()
        c.incidents = store.allIncidents.count
        let handled = Set(store.findingActions.filter { $0.action == "acknowledged" || $0.action == "muted" }.map(\.anomalyKey))
        c.untriaged = store.allIncidents.filter { !handled.contains($0.anomalyKey) }.count
        c.surfaces = store.aiSurfaces.count
        return c
    }
}

/// Sidebar glyph that plays a one-shot SF Symbol effect on hover and when its row
/// becomes selected — the native stand-in for animated Lucide icons.
private struct NavIcon: View {
    let section: DashSection
    let selected: Bool
    @State private var pulse = 0

    var body: some View {
        symbol
            .onHover { if $0 { pulse &+= 1 } }
            .onChange(of: selected) { _, now in if now { pulse &+= 1 } }
    }

    // .rotate / .wiggle need macOS 15; the package floor is 15, so no #available.
    @ViewBuilder private var symbol: some View {
        let img = Image(systemName: section.icon)
        switch section {
        case .dashboard: img.symbolEffect(.bounce.up.byLayer, options: .nonRepeating, value: pulse)
        case .incidents: img.symbolEffect(.wiggle, options: .nonRepeating, value: pulse)
        case .breakdown: img.symbolEffect(.bounce.up, options: .nonRepeating, value: pulse)
        case .settings:  img.symbolEffect(.rotate, options: .nonRepeating, value: pulse)
        case .triage:    img.symbolEffect(.bounce, options: .nonRepeating, value: pulse)
        case .shadowAI:  img.symbolEffect(.pulse, options: .nonRepeating, value: pulse)
        case .posture, .exposure, .blast, .behaviour, .people, .privacy: img
        }
    }
}

struct DashboardView: View {
    @Bindable var store: Store
    let updateChecker: UpdateChecker
    // Shared with the menu-bar panel's "Settings" item (see VoleApp / MenuPanel).
    @AppStorage("vole.section") private var sectionRaw = DashSection.dashboard.rawValue
    private var nav: DashSection { DashSection(rawValue: sectionRaw) ?? .dashboard }
    private var navSelection: Binding<DashSection?> {
        Binding(get: { nav }, set: { sectionRaw = ($0 ?? .dashboard).rawValue })
    }
    @State private var selectedDate: Date?
    @State private var expandedIncidents: Set<Int> = []
    @State private var expandedModels: Set<String> = []
    /// Set by picking an incident mark on the timeline: the Incidents list shows
    /// only that bucket until cleared.
    @State private var incidentFilterBucket: Int?
    @AppStorage("vole.theme") private var theme = "system"
    @AppStorage("vole.menubar") private var menubar = "tokens"
    @AppStorage("vole.refresh") private var refreshSeconds = RefreshInterval.live.rawValue
    @AppStorage("vole.loginItem") private var launchAtLogin = false

    private var selectedBucket: Int? {
        selectedDate.map { (Int($0.timeIntervalSince1970 * 1000) / store.range.bucketMs) * store.range.bucketMs }
    }

    var body: some View {
        NavigationSplitView {
            List(selection: navSelection) {
                ForEach(SidebarGroup.allCases) { g in
                    Section(g.rawValue) {
                        ForEach(DashSection.inGroup(g)) { s in
                            Label { Text(s.rawValue) } icon: { NavIcon(section: s, selected: nav == s) }
                                .badge(badge(for: s))
                                .tag(s)
                        }
                    }
                }
            }
            .navigationTitle("Vole")
            .navigationSplitViewColumnWidth(min: 200, ideal: 220, max: 280)
        }         detail: {
            Group {
                if store.storeIsFromTheFuture {
                    futureStoreView
                } else if let missing = nav.missingTables(available: store.availableTables) {
                    // Capability probe: this section's backing table is absent —
                    // the store predates it. Say so; never render an empty list
                    // that reads as "we looked and found nothing".
                    ContentUnavailableView {
                        Label("\(nav.rawValue) Unavailable", systemImage: "questionmark.square.dashed")
                    } description: {
                        Text("This store has no \(missing.joined(separator: ", ")) — it is written by \(nav.arrivesWith), which this Vole does not include yet. The section appears with real figures the day that collector runs.")
                    }
                } else {
                    switch (nav, store.collectorStatus) {
                    case (.settings, _), (_, .live):
                        detailPane
                    case (_, .noData):
                        noDataView
                    case (_, .stale(let since)):
                        VStack(spacing: 0) {
                            StaleBanner(since: since)
                                .padding([.horizontal, .top], 16).padding(.bottom, 2)
                            detailPane
                        }
                    }
                }
            }
            .navigationTitle(nav.rawValue)
            .onChange(of: refreshSeconds) { _, new in store.setRefresh(new) }
            .toolbar {
                // .navigation groups with the system sidebar toggle, at the toolbar's
                // leading edge — visible everywhere, not just Dashboard/Breakdown,
                // since an available update isn't section-specific.
                if updateChecker.updateAvailable {
                    ToolbarItem(placement: .navigation) {
                        Button {
                            updateChecker.installOrUpdate()
                        } label: {
                            Image(systemName: "arrow.down.circle")
                                .overlay(alignment: .topTrailing) {
                                    Circle().fill(.red).frame(width: 6, height: 6)
                                }
                        }
                        .help("Update available\(updateChecker.latestVersion.map { " — v\($0)" } ?? "") — click to install")
                    }
                }
                // The range filter drives the Dashboard timeline and Breakdown; the
                // Incidents feed and Settings don't use it. A fixed ToolbarSpacer keeps
                // the badge and the picker as separate Liquid Glass groups.
                if nav == .dashboard || nav == .breakdown {
                    if store.summary.hasSeed {
                        ToolbarItem {
                            Label("Demo Data", systemImage: "testtube.2")
                                .foregroundStyle(.orange)
                        }
                        ToolbarSpacer(.fixed)
                    }
                    ToolbarItem {
                        RangeSelector(selection: $store.range).fixedSize()
                    }
                }
            }
        }
        .frame(minWidth: 920, minHeight: 600)
        .onDisappear { NSApp.setActivationPolicy(.accessory) }
    }

    /// One COUNT per section, refreshed on the existing Store poll.
    private func badge(for s: DashSection) -> Int {
        s.badge(counts: sectionCounts)
    }

    private var sectionCounts: SectionCounts { SectionCounts.compute(store) }

    @ViewBuilder private var detailPane: some View {
        switch nav {
        case .dashboard: dashboardPane
        case .incidents: incidentsPane
        case .breakdown: breakdownPane
        case .triage:    TriagePane(store: store)
        case .shadowAI:  ShadowAIPane(store: store)
        case .exposure:  DataExposurePane(store: store)
        case .behaviour: BehaviourPane(store: store)
        case .blast:     BlastRadiusPane(store: store)
        case .posture:   PosturePane(store: store)
        case .people:    PeoplePane(store: store)
        case .privacy:   PrivacyPane(store: store)
        case .settings:  settingsPane
        }
    }

    /// Version gate: the store was written by a newer Vole, and every figure this
    /// app could render is suspect — rows may carry columns this reader predates.
    /// A downgrade cannot un-write rows, only refuse to present them as truth.
    private var futureStoreView: some View {
        ContentUnavailableView {
            Label("Store written by a newer Vole", systemImage: "exclamationmark.shield.fill")
        } description: {
            Text("This database is schema \(store.storeSchemaVersion); this app understands schema \(DB.knownSchemaVersion). Figures may be missing or wrong — update Vole before trusting anything it shows from this store.")
        }
    }

    private var noDataView: some View {        // A bundled app runs its own collector — telling that user to run a pnpm
        // command would be asking them to do something they have no Node, no pnpm,
        // and no terminal to do. Only an unbundled dev build shows the command.
        let embedded = Collector.isEmbedded
        return ContentUnavailableView {
            Label(embedded ? "Setting up" : "Waiting for the collector",
                  systemImage: "bolt.horizontal.circle")
        } description: {
            Text(embedded
                 ? "Vole is starting its collector. This takes just a few seconds."
                 : "Vole reads a local database the collector writes. Start it, then keep it running.")
        } actions: {
            if !embedded {
                HStack(spacing: 8) {
                    Text(store.collectCommand)
                        .font(.callout.monospaced())
                        .fixedSize()
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(.background.tertiary,
                                    in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                    Button("Copy") { copyToPasteboard(store.collectCommand) }
                }
                .fixedSize()
            }
        }
    }

    // MARK: Dashboard

    private var dashboardPane: some View {
        Form {
            let s = store.summary
            Section {
                CoverageStrip(heartbeats: store.heartbeats)
            } footer: {
                Text("One chip per collector, from its latest pass. Grey means the tool's artifacts do not exist on this Mac — absence, never zero usage.")
            }
            // Security first (#38): a security buyer's questions lead; cost follows.
            Section {
                let rerouted = store.allIncidents.filter { $0.rule == "rerouted_model" }.count
                let gateways = store.aiSurfaces.filter { $0.kind == "gateway" }.count
                let unsanctioned = store.aiSurfaces.filter { $0.sanctioned == false }.count
                metricRow("AI Surfaces", "\(store.aiSurfaces.count)", "sparkle.magnifyingglass", .blue, prominent: true)
                metricRow("Persistent Gateways", "\(gateways)", "arrow.triangle.branch", gateways > 0 ? .orange : .secondary)
                metricRow("Unsanctioned", unsanctioned > 0 ? "\(unsanctioned)" : "—", "exclamationmark.shield", unsanctioned > 0 ? .red : .secondary)
                metricRow("Rerouted Models", rerouted > 0 ? "\(rerouted)" : "—", "arrow.triangle.swap", rerouted > 0 ? .orange : .secondary)
                metricRow("Active Incidents", "\(store.allIncidents.count)", "exclamationmark.triangle", .secondary)
            } header: {
                Text("Security")
            } footer: {
                Text("Counts on this Mac, from its own evidence — never a fleet posture.")
            }
            Section {
                metricRow("Tokens", Fmt.compact(s.tokens), "circle.hexagongrid.fill", .blue, prominent: true)
                metricRow("Equivalent Cost", Fmt.money(s.cost), "dollarsign", .green, prominent: true)
                // The ungated-call KPI (tier 5 #8): calls that ran with no gate at all,
                // beside tokens and cost. Zero is a real figure; the denominator rides
                // in the tooltip so the count can never imply more coverage than it has.
                if let u = store.ungated {
                    metricRow("Ungated Tool Calls", u.calls > 0 ? "\(u.calls)" : "0",
                              "exclamationmark.shield", u.calls > 0 ? .red : .secondary)
                        .help("Calls with no permission gate at all (bypass_no_gate) in this range, of \(u.totalCalls) recorded tool calls.")
                }
                if let speed = store.tokenSpeed {
                    metricRow("Burn Rate", "\(Fmt.compactDbl(speed.perMin))/min", "speedometer", .orange)
                    metricRow("Peak Minute (24h)", "\(Fmt.compactDbl(speed.peakPerMin))/min", "chart.bar.fill", .secondary)
                }
            } header: {
                Text("Activity")
            } footer: {
                Text(s.hasActivityOnly
                     ? "Verbatim from tool logs. Sources that record no tokens are excluded."
                     : "Verbatim from tool logs.")
            }

            Section("Activity") {
                metricRow("Calls", Fmt.compact(s.calls), "arrow.up.arrow.down", .secondary)
                metricRow("Sessions", "\(s.sessions)", "rectangle.stack", .secondary)
                metricRow("Cache Hit", Fmt.pct(s.cacheHitRatio), "arrow.triangle.2.circlepath", .teal)
                metricRow("Errors", "\(s.errors)", "exclamationmark.triangle",
                          s.errors > 0 ? .red : .secondary)
            }

            Section {
                if store.modelSpeeds.isEmpty {
                    Text("No model states a response duration in this range — speed needs rows with known durations (OpenCode does; it says so, and the rest are counted, not guessed.")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    ForEach(Array(store.modelSpeeds.enumerated()), id: \.offset) { _, m in
                        HStack(spacing: 10) {
                            ToolIcon(tool: m.tool, size: 14)
                            Text(m.model ?? "unknown model")
                                .font(.callout).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Text(String(format: "%.1f tok/s", m.tokensPerSecond))
                                .font(.callout.monospacedDigit()).fontWeight(.medium)
                            Text(m.kind == "measured" ? "measured" : "est.")
                                .font(.caption2)
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background((m.kind == "measured" ? Color.green : Color.orange).opacity(0.14), in: Capsule())
                                .foregroundStyle(m.kind == "measured" ? Color.green : Color.orange)
                                .help(m.kind == "measured"
                                      ? "The source states the response span (OpenCode)." 
                                      : "Estimated from turn gaps — includes queue and permission time, so this is a lower bound on true speed.")
                            Text("\(Int(m.coverage * 100))%")
                                .font(.caption2).monospacedDigit()
                                .foregroundStyle(m.coverage >= 0.9 ? AnyShapeStyle(HierarchicalShapeStyle.secondary) : AnyShapeStyle(Color.orange))
                                .help("Share of this model's output tokens whose response duration is known — the figure covers those rows only.")
                        }
                    }
                }
            } header: {
                Text("Model Speed (generation)")
            } footer: {
                Text("Output tokens per second, measured over responses that state a real duration. Coverage is printed beside every figure: a speed without its coverage is a benchmark, not a measurement.")
            }

            Section("Timeline") {
                TimelineChart(series: store.series, incidents: store.incidents,
                              bucketMs: store.range.bucketMs, selectedDate: $selectedDate,
                              onPickIncident: { bucket in
                                  incidentFilterBucket = bucket
                                  sectionRaw = DashSection.incidents.rawValue
                              })
                    .padding(.vertical, 4)
            }
        }
        .formStyle(.grouped)
    }

    func metricRow(_ label: String, _ value: String, _ symbol: String,
                           _ tint: Color, prominent: Bool = false) -> some View {
        LabeledContent {
            Text(value)
                .font(prominent ? .system(.title2, design: .rounded).weight(.semibold) : .body)
                .monospacedDigit()
                .foregroundStyle(prominent ? .primary : .secondary)
                .contentTransition(.numericText())
                .animation(.default, value: value)   // otherwise the poll just snaps
        } label: {
            Label {
                Text(label)
            } icon: {
                Image(systemName: symbol).foregroundStyle(tint)
            }
        }
    }

    // MARK: Incidents

    private var incidentsByDay: [(day: Date, items: [Incident])] {
        let cal = Calendar.current
        return Dictionary(grouping: store.allIncidents) {
            cal.startOfDay(for: Date(timeIntervalSince1970: Double($0.windowStart) / 1000))
        }
        .sorted { $0.key > $1.key }
        .map { ($0.key, $0.value) }
    }

    private func dayLabel(_ d: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(d) { return "Today" }
        if cal.isDateInYesterday(d) { return "Yesterday" }
        if let n = cal.dateComponents([.day], from: d, to: .now).day, n < 7 {
            return d.formatted(.dateTime.weekday(.wide))
        }
        return d.formatted(.dateTime.month(.abbreviated).day())
    }

    func copy(_ s: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
    }

    @ViewBuilder
    private var incidentsPane: some View {
        if store.allIncidents.isEmpty {
            ContentUnavailableView("All Quiet", systemImage: "checkmark.circle",
                                   description: Text("No anomalies detected in this range."))
        } else if let fb = incidentFilterBucket {
            // Picked from the timeline's incident lane: this bucket only, with the
            // way out visible at the top rather than a silent filter.
            let items = store.allIncidents.filter { $0.bucket(store.range.bucketMs) == fb }
            List {
                Section {
                    HStack {
                        Label("Filtered to one timeline bucket", systemImage: "line.3.horizontal.decrease.circle")
                            .font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button("Show all") { incidentFilterBucket = nil }
                            .buttonStyle(.link).font(.caption)
                    }
                    .listRowBackground(Color.clear)
                    ForEach(items) { i in incidentRow(i) }
                }
            }
            .listStyle(.inset)
            .defaultScrollAnchor(.top)
        } else {
            List {
                ForEach(incidentsByDay, id: \.day) { group in
                    Section(dayLabel(group.day)) {
                        ForEach(group.items) { i in incidentRow(i) }
                    }
                }
            }
            .listStyle(.inset)
            .defaultScrollAnchor(.top)
        }
    }

    @ViewBuilder
    private func incidentRow(_ i: Incident) -> some View {
        let open = expandedIncidents.contains(i.id)
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: Pal.severityIcon(i.severity))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(Pal.severity(i.severity))
                    .font(.body)
                    .frame(width: 18)

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(Labels.rule[i.rule] ?? i.rule).fontWeight(.semibold)
                        ToolIcon(tool: i.tool, size: 14)
                        Text(Labels.tool[i.tool] ?? i.tool).foregroundStyle(.secondary)
                        if i.confidence != "exact" { ConfidenceBadge(i.confidence) }
                    }
                    Text(i.detail)
                        .font(.callout).foregroundStyle(.secondary)
                        .lineLimit(open ? nil : 2)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 8)
                Text(Fmt.rel(i.windowStart))
                    .font(.caption).monospacedDigit().foregroundStyle(.secondary)
            }

            if open {
                // The figures that fired, machine-readable: principle 3 says an incident
                // is explainable from real numbers, not just prose.
                if i.baseline != nil || i.threshold != nil {
                    HStack(spacing: 4) {
                        Text("observed").font(.caption2).foregroundStyle(.tertiary)
                        Text(Fmt.compactDbl(i.observed)).font(.caption2).monospacedDigit()
                        if let b = i.baseline {
                            Text("· baseline").font(.caption2).foregroundStyle(.tertiary)
                            Text(Fmt.compactDbl(b)).font(.caption2).monospacedDigit()
                        }
                        if let t = i.threshold {
                            Text("· threshold").font(.caption2).foregroundStyle(.tertiary)
                            Text(Fmt.compactDbl(t)).font(.caption2).monospacedDigit()
                        }
                    }
                    .padding(.leading, 28)
                }
                HStack(spacing: 14) {
                    if let sid = i.sessionID {
                        Label(sid.prefix(14), systemImage: "number")
                            .font(.caption2).foregroundStyle(.tertiary)
                            .textSelection(.enabled)
                    }
                    Text("\(Fmt.clock(i.windowStart))–\(Fmt.clock(i.windowEnd))")
                        .font(.caption2).monospacedDigit().foregroundStyle(.tertiary)
                    Text(i.anomalyKey)
                        .font(.system(.caption2, design: .monospaced)).foregroundStyle(.tertiary)
                        .lineLimit(1).truncationMode(.middle)
                        .textSelection(.enabled)
                        .help("Stable dedupe key — copyable for evidence")
                    Spacer()
                    Button("Show on Timeline") {
                        selectedDate = Date(timeIntervalSince1970:
                            Double(i.bucket(store.range.bucketMs)) / 1000)
                        sectionRaw = DashSection.dashboard.rawValue
                    }
                    .buttonStyle(.link).font(.caption)
                }
                .padding(.leading, 28)
            }
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .onTapGesture {
            withAnimation(.snappy(duration: 0.2)) {
                if open { expandedIncidents.remove(i.id) } else { expandedIncidents.insert(i.id) }
            }
        }
        .contextMenu {
            Button("Copy Details", systemImage: "doc.on.doc") { copy(i.detail) }
            if let sid = i.sessionID {
                Button("Copy Session ID", systemImage: "number") { copy(sid) }
            }
            Button("Show on Timeline", systemImage: "chart.xyaxis.line") {
                selectedDate = Date(timeIntervalSince1970:
                    Double(i.bucket(store.range.bucketMs)) / 1000)
                sectionRaw = DashSection.dashboard.rawValue
            }
        }
    }

    // MARK: Breakdown

    private var breakdownByTool: [(tool: String, rows: [BreakdownRow])] {
        // Grouped by the tools the DATA holds, ordered by that group's token total —
        // an unlisted tool appears with a fallback label instead of disappearing.
        let grouped = Dictionary(grouping: store.breakdown, by: \.tool)
        return grouped
            .map { (tool: $0.key, rows: $0.value.sorted { $0.tokensSort > $1.tokensSort }) }
            .sorted { a, b in
                let at = a.rows.compactMap(\.tokens).reduce(0, +)
                let bt = b.rows.compactMap(\.tokens).reduce(0, +)
                return at == bt ? a.tool < b.tool : at > bt
            }
    }

    @ViewBuilder
    private var breakdownPane: some View {
        if store.breakdown.isEmpty {
            ContentUnavailableView("No Usage", systemImage: "tablecells",
                                   description: Text("No model calls recorded in this range."))
        } else {
            List {
                ForEach(breakdownByTool, id: \.tool) { group in
                    Section {
                        ForEach(group.rows) { r in breakdownRow(r) }
                    } header: {
                        let toks = group.rows.compactMap(\.tokens)
                        HStack(spacing: 7) {
                            ToolIcon(tool: group.tool, size: 18)
                            Text(Labels.tool[group.tool] ?? group.tool)
                            Spacer()
                            Text(toks.isEmpty ? "—" : Fmt.compact(toks.reduce(0, +)))
                                .monospacedDigit().foregroundStyle(.secondary)
                        }
                        .font(.subheadline.weight(.semibold))
                        .textCase(nil)
                    }
                }
                // Server-tool billing (tier 8 #33): billed per request, not per token.
                if !store.serverTools.isEmpty {
                    Section {
                        ForEach(store.serverTools) { t in
                            LabeledContent(serverToolLabel(t.linkKind)) {
                                Text("\(t.requests)").monospacedDigit()
                            }
                        }
                    } header: {
                        Text("Server Tools")
                    } footer: {
                        Text("Request counters the vendor bills as their own line item (web search, web fetch). Claude Code only — other tools report none, which is absence, never zero.")
                    }
                }
            }
            .listStyle(.inset)
        }
    }

    @ViewBuilder
    private func breakdownRow(_ r: BreakdownRow) -> some View {
        let open = expandedModels.contains(r.id)
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        // Devin / Cursor / Antigravity report no model name — don't show a bare dash.
                        Text(r.model ?? (r.confidence == "activity_only" ? "Sessions" : "Unknown model"))
                            .fontWeight(.semibold)
                            .lineLimit(1).truncationMode(.middle)
                        if r.confidence != "exact" { ConfidenceBadge(r.confidence) }
                    }
                    Text(r.tokens == nil
                         ? "\(r.calls) calls"
                         : "\(r.calls) calls · \(Fmt.compact(r.tokens)) tokens")
                        .font(.callout).monospacedDigit().foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Text(Fmt.money(r.cost))
                    .font(.callout).monospacedDigit()
                    .foregroundStyle(r.cost == nil ? .tertiary : .secondary)
            }

            if open {
                HStack(spacing: 14) {
                    miniStat("Cache read", Fmt.compact(r.cacheRead))
                    miniStat("Output", Fmt.compact(r.output))
                    Spacer()
                    Button("Copy Model") { copy(r.model ?? "") }
                        .buttonStyle(.link).font(.caption)
                }
            }
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .onTapGesture {
            withAnimation(.snappy(duration: 0.2)) {
                if open { expandedModels.remove(r.id) } else { expandedModels.insert(r.id) }
            }
        }
        .contextMenu {
            Button("Copy Model", systemImage: "doc.on.doc") { copy(r.model ?? "") }
        }
    }

    private func miniStat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption2).foregroundStyle(.tertiary)
            Text(value).font(.caption2).monospacedDigit().foregroundStyle(.secondary)
        }
    }

    private func serverToolLabel(_ kind: String) -> String {
        switch kind {
        case "web_search_requests": return "Web search requests"
        case "web_fetch_requests": return "Web fetch requests"
        default: return kind
        }
    }

    // MARK: Settings

    private func setLaunchAtLogin(_ on: Bool) {
        // Works once the app is a signed .app bundle; a no-op (logged) in a dev run.
        do {
            if on { try SMAppService.mainApp.register() }
            else  { try SMAppService.mainApp.unregister() }
        } catch {
            NSLog("[login item] \(error.localizedDescription)")
        }
    }

    private var settingsHeader: some View {
        HStack(spacing: 14) {
            Group {
                if let icon = NSApp.applicationIconImage {
                    Image(nsImage: icon).resizable()
                } else {
                    Image(systemName: "shippingbox.fill").font(.system(size: 30))
                }
            }
            .frame(width: 56, height: 56)
            .shadow(color: .black.opacity(0.18), radius: 5, y: 2)
            VStack(alignment: .leading, spacing: 3) {
                Text("Vole").font(.title2.weight(.semibold))
                Text("Version \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev")")
                    .font(.callout).foregroundStyle(.secondary)
                Text("Local usage & anomaly monitor for AI coding agents")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.vertical, 6)
        .listRowInsets(EdgeInsets(top: 12, leading: 4, bottom: 12, trailing: 4))
        .listRowBackground(Color.clear)
    }

    private var settingsPane: some View {
        Form {
            Section { settingsHeader }

            Section {
                LabeledContent("Schema version") {
                    Text(store.storeSchemaVersion == 0 ? "pre-ledger" : "v\(store.storeSchemaVersion)")
                        .monospacedDigit()
                        .foregroundStyle(store.storeIsFromTheFuture ? .red : .primary)
                }
                if store.storeIsFromTheFuture {
                    Label("This store was written by a newer Vole — figures may be missing or wrong.",
                          systemImage: "exclamationmark.shield.fill")
                        .foregroundStyle(.red).font(.caption)
                }
                // The upgrade boundary, visible: a step with an unknown date means
                // everything before it predates that capability, and charts of it
                // must read "not recorded", never zero.
                ForEach(store.migrationLedger) { row in
                    HStack {
                        Text("v\(row.version) · \(row.name)")
                            .font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Text(row.appliedAt == nil ? "unknown (pre-ledger)" : Fmt.rel(row.appliedAt!))
                            .font(.caption2).monospacedDigit().foregroundStyle(.tertiary)
                    }
                }
            } header: {
                Text("Store Schema")
            } footer: {
                Text("Figures from before a step's date do not include what that step added — read absence as 'not recorded then', never as zero.")
            }

            Section {
                SoftwareUpdatePane(checker: updateChecker)
            } header: {
                Text("Software Update")
            } footer: {
                Text("Updates install only when the release publishes a checksummed archive — unverifiable code is never swapped into a running app.")
            }

            Section("General") {
                Picker("Appearance", selection: $theme) {
                    Text("System").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
                Toggle("Launch at Login", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { _, on in setLaunchAtLogin(on) }
                Picker("Menu Bar Shows", selection: $menubar) {
                    Text("Token count").tag("tokens")
                    Text("Equivalent cost").tag("cost")
                    Text("Token speed").tag("speed")
                    Text("Icon only").tag("icon")
                }
            }

            Section {
                // Observation lag (tier 7 #39): two clocks on every row. The figure
                // folds flush delay and Vole's own poll together — an upper bound,
                // stated as such, never presented as the agent's own latency.
                if store.observationLags.isEmpty {
                    Text("No row states an observation time yet — lag is unknown, never zero.")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    ForEach(store.observationLags) { lag in
                        HStack {
                            ToolIcon(tool: lag.tool, size: 14)
                            Text(Labels.tool[lag.tool] ?? lag.tool)
                            Spacer()
                            if let p50 = lag.p50Ms, let p95 = lag.p95Ms {
                                Text("p50 \(Fmt.compactDbl(p50 / 1000))s · p95 \(Fmt.compactDbl(p95 / 1000))s")
                                    .font(.callout).monospacedDigit().foregroundStyle(.secondary)
                                    .help("Over \(lag.observedRows) observed rows — incidents for this tool are detected on average \(Fmt.compactDbl(p50 / 1000))s after the call, at worst \(Fmt.compactDbl(p95 / 1000))s.")
                            } else {
                                Text("—").foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
            } header: {
                Text("Sources · Observation Lag")
            } footer: {
                Text("How long after a call Vole saw it: observed_at minus the agent's own timestamp. An upper bound that folds flush delay and the poll interval together — the two cannot be separated from the log.")
            }

            Section {
                Picker("Refresh", selection: $refreshSeconds) {
                    ForEach(RefreshInterval.allCases) { Text($0.label).tag($0.rawValue) }
                }
                LabeledContent("Database") {
                    Label(store.dbOK ? "Connected" : "Not found",
                          systemImage: store.dbOK ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .foregroundStyle(store.dbOK ? .green : .red)
                        .labelStyle(.titleAndIcon)
                }
                Button("Show Database in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting(
                        [URL(fileURLWithPath: store.dbPath)])
                }
            } header: {
                Text("Data")
            } footer: {
                Text(verbatim: store.dbPath).textSelection(.enabled)
            }

            Section {
                LabeledContent("Verification", value: "Every stored row reconciled")
                if let url = URL(string: "https://github.com/launchsafe/vole") {
                    Link("Source & Documentation", destination: url)
                }
            } header: {
                Text("About")
            } footer: {
                Text("Vole reads your AI coding tools' local logs read-only and flags runaway "
                     + "loops, burn spikes and retry storms. Nothing leaves your machine.")
            }
        }
        .formStyle(.grouped)
    }
}
