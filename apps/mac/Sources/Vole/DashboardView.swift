import SwiftUI
import AppKit
import Charts
import ServiceManagement

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
    private var toolTotals: [(tool: String, tokens: Int)] {
        Labels.order
            .map { t in (t, series.reduce(0) { $0 + ($1.tokensByTool[t] ?? 0) }) }
            .filter { $0.1 > 0 }
            .sorted { $0.1 > $1.1 }
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

            logoStrip
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
    case app     = "App"
    var id: String { rawValue }
}

enum DashSection: String, CaseIterable, Identifiable {
    case dashboard = "Dashboard"
    case incidents = "Incidents"
    case breakdown = "Breakdown"
    case settings  = "Settings"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .dashboard: return "square.grid.2x2"
        case .incidents: return "exclamationmark.triangle"
        case .breakdown: return "square.stack.3d.up"
        case .settings:  return "gearshape"
        }
    }
    var group: SidebarGroup {
        self == .settings ? .app : .monitor
    }
    static func inGroup(_ g: SidebarGroup) -> [DashSection] {
        allCases.filter { $0.group == g }
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
        }
    }
}

struct DashboardView: View {
    @Bindable var store: Store
    // Shared with the menu-bar panel's "Settings" item (see VoleApp / MenuPanel).
    @AppStorage("vole.section") private var sectionRaw = DashSection.dashboard.rawValue
    private var nav: DashSection { DashSection(rawValue: sectionRaw) ?? .dashboard }
    private var navSelection: Binding<DashSection?> {
        Binding(get: { nav }, set: { sectionRaw = ($0 ?? .dashboard).rawValue })
    }
    @State private var selectedDate: Date?
    @State private var expandedIncidents: Set<Int> = []
    @State private var expandedModels: Set<String> = []
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
                                .badge(s == .incidents ? store.allIncidents.count : 0)
                                .tag(s)
                        }
                    }
                }
            }
            .navigationTitle("Vole")
            .navigationSplitViewColumnWidth(min: 200, ideal: 220, max: 280)
        } detail: {
            Group {
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
            .navigationTitle(nav.rawValue)
            .onChange(of: refreshSeconds) { _, new in store.setRefresh(new) }
            .toolbar {
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

    @ViewBuilder private var detailPane: some View {
        switch nav {
        case .dashboard: dashboardPane
        case .incidents: incidentsPane
        case .breakdown: breakdownPane
        case .settings:  settingsPane
        }
    }

    private var noDataView: some View {
        // A bundled app runs its own collector — telling that user to run a pnpm
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
                metricRow("Tokens", Fmt.compact(s.tokens), "circle.hexagongrid.fill", .blue, prominent: true)
                metricRow("Equivalent Cost", Fmt.money(s.cost), "dollarsign", .green, prominent: true)
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

            Section("Timeline") {
                TimelineChart(series: store.series, incidents: store.incidents,
                              bucketMs: store.range.bucketMs, selectedDate: $selectedDate)
                    .padding(.vertical, 4)
            }
        }
        .formStyle(.grouped)
    }

    private func metricRow(_ label: String, _ value: String, _ symbol: String,
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

    private func copy(_ s: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
    }

    @ViewBuilder
    private var incidentsPane: some View {
        if store.allIncidents.isEmpty {
            ContentUnavailableView("All Quiet", systemImage: "checkmark.circle",
                                   description: Text("No anomalies detected in this range."))
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
                HStack(spacing: 14) {
                    if let sid = i.sessionID {
                        Label(sid.prefix(14), systemImage: "number")
                            .font(.caption2).foregroundStyle(.tertiary)
                            .textSelection(.enabled)
                    }
                    Text("\(Fmt.clock(i.windowStart))–\(Fmt.clock(i.windowEnd))")
                        .font(.caption2).monospacedDigit().foregroundStyle(.tertiary)
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
        let grouped = Dictionary(grouping: store.breakdown, by: \.tool)
        return Labels.order.compactMap { t in
            guard let rows = grouped[t], !rows.isEmpty else { return nil }
            return (t, rows.sorted { $0.tokensSort > $1.tokensSort })
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
                Text("Version 0.1.0").font(.callout).foregroundStyle(.secondary)
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
                    Text("Icon only").tag("icon")
                }
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
