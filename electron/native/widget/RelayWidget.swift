// Relay's macOS widgets: the account open in Claude with its limits, the other
// accounts, and today's and the week's Claude Code tokens with their API value.
// Relay writes ~/Library/Application Support/Relay/widget/today.json with every
// string already formatted; this extension only reads and draws it. Built by
// scripts/build-native.mjs with -e _NSExtensionMain (without it chronod starts
// the extension and it exits: "Unrecognized extension type").
//
// A widget never switches accounts. Its Geç buttons open relay://switch links:
// Relay shows its usual switch review for that account, and nothing more.
//
// Two looks. In full colour the widgets use Relay's colours: the brand orange,
// amber and red for a limit's tone, and a colour per account in the stacked
// bars. When the desktop is not focused macOS draws them vibrant: it drops the
// background, desaturates everything and turns lightness into opacity, so hues
// collapse into one tone. There every mark is the primary colour and hierarchy
// comes from opacity and weight (see `Look`); the key marks are accentable.
import SwiftUI
import WidgetKit

// MARK: - The file

struct Snapshot: Decodable {
  struct Texts: Decodable {
    let title: String
    let subtitle: String
    let rows: [String]
    let input: String
    let output: String
    let cache: String
    let total: String
    let cost: String
    let change: String
    let status: String
    let empty: String
    let stale: String
    let costTokens: String
    let todayLine: String
    let allToday: String
    let switchWord: String
    let left: String
    let noActive: String
    // Added with the panda; a file from an older Relay has none of them.
    let tokens: String?
    let apiTitle: String?
    let others: String?
    let todayWord: String?
    let inClaude: String?
    let suggested: String?

    enum CodingKeys: String, CodingKey {
      case title, subtitle, rows, input, output, cache, total, cost, change, status, empty, stale
      case costTokens, todayLine, allToday, left, noActive
      case tokens, apiTitle, others, todayWord, inClaude, suggested
      case switchWord = "switch"
    }
  }
  struct AccountTexts: Decodable {
    let fiveHour: String
    let week: String
    let limits: String
    let cost: String
    let tokens: String
    let costTokens: String
    let left: String
    let weekReset: String
    let weekShort: String
    // The active account's.
    let weekLine: String?
    let costChip: String?
    let tokensChip: String?
    // Another account's.
    let switchTo: String?
  }
  struct Account: Decodable, Identifiable {
    let id: String
    let name: String
    let fiveHour: Double?
    let week: Double?
    let fiveHourResetsAt: Double?
    let cost: Double
    let tokens: Double
    let color: Int
    let suggested: Bool?
    let switchable: Bool?
    let link: String?
    let text: AccountTexts

    /** The review link, only while Relay can review a switch to this account. */
    var url: URL? {
      guard switchable == true, let link, link.hasPrefix("relay://switch?") else { return nil }
      return URL(string: link)
    }
  }
  struct SplitPart: Decodable, Identifiable {
    struct Texts: Decodable { let cost: String }
    let key: String
    let name: String
    let color: Int
    let cost: Double
    let share: Double
    let text: Texts
    var id: String { key }
  }
  struct Week: Decodable {
    struct Day: Decodable, Identifiable {
      let date: String
      let label: String
      let today: Bool
      let cost: Double
      let parts: [Double]
      var id: String { date }
    }
    struct Texts: Decodable {
      let title: String
      let cost: String
      let tokens: String
      let average: String
      let busiest: String
      let hits: String
      let activeWeek: String
    }
    let days: [Day]
    let cost: Double
    let tokens: Double
    let average: Double
    let hits: Int?
    let text: Texts
  }
  let version: Int
  let generatedAt: Double
  let date: String
  let zone: String
  let state: String
  /** The panda's face: happy, alert, worried or sleeping (shared/widget-snapshot.ts `widgetMood`). */
  let mood: String?
  let change: Double?
  let slots: [Double?]
  let yesterdayAverage: Double?
  let active: Account?
  let accounts: [Account]?
  let split: [SplitPart]?
  let week: Week?
  let text: Texts

  var others: [Account] { accounts ?? [] }
  var suggested: Account? { others.first { $0.suggested == true && $0.url != nil } }
}

/** The file Relay writes; the sandbox lets the widget read this one directory. */
private func snapshotURL() -> URL {
  // The sandbox's home is the container; the file is under the real one.
  var home = NSHomeDirectory()
  if let user = getpwuid(getuid()), let dir = user.pointee.pw_dir {
    home = String(cString: dir)
  }
  return URL(fileURLWithPath: home)
    .appendingPathComponent("Library/Application Support/Relay/widget/today.json")
}

private func readSnapshot() -> Snapshot? {
  guard let data = try? Data(contentsOf: snapshotURL()),
    let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data),
    snapshot.version == 2
  else { return nil }
  return snapshot
}

/** The calendar date of `time` in `zone`, as Relay writes it. */
private func localDate(_ time: Date, _ zone: String) -> String {
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.timeZone = TimeZone(identifier: zone) ?? .current
  formatter.dateFormat = "yyyy-MM-dd"
  return formatter.string(from: time)
}

private func nextMidnight(after time: Date, _ zone: String) -> Date? {
  var calendar = Calendar(identifier: .gregorian)
  calendar.timeZone = TimeZone(identifier: zone) ?? .current
  return calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: time))
}

/** Time left until `resetsAt` (epoch ms) as "h:mm"; nil once it passed. */
private func countdown(_ resetsAt: Double?, at date: Date) -> String? {
  guard let resetsAt else { return nil }
  let left = resetsAt - date.timeIntervalSince1970 * 1000
  guard left > 0 else { return nil }
  let minutes = Int((left / 60_000).rounded(.up))
  return String(format: "%d:%02d", minutes / 60, minutes % 60)
}

private let staleAfter: TimeInterval = 30 * 60

// MARK: - Timeline

struct TodayEntry: TimelineEntry {
  let date: Date
  let snapshot: Snapshot?

  /** The file is from an earlier day than the entry's: show the new day empty. */
  var newDay: Bool {
    guard let snapshot else { return false }
    return localDate(date, snapshot.zone) != snapshot.date
  }
  var stale: Bool {
    guard let snapshot else { return false }
    return date.timeIntervalSince1970 * 1000 - snapshot.generatedAt > staleAfter * 1000
  }
  /** The active account's five-hour countdown at this entry. */
  var left: String? { countdown(snapshot?.active?.fiveHourResetsAt, at: date) }

  /** The panda's face: Relay's, asleep while the file is old or from another day. */
  var mood: String {
    guard let snapshot, !stale, !newDay else { return "sleeping" }
    if let mood = snapshot.mood { return mood }
    // A file from a Relay before the panda: the same rule as widgetMood.
    guard snapshot.state != "scanning", let active = snapshot.active else { return "sleeping" }
    if (active.fiveHour ?? 0) >= 100 || (active.week ?? 0) >= 100 { return "worried" }
    return (active.fiveHour ?? 0) >= 80 ? "alert" : "happy"
  }
}

struct TodayProvider: TimelineProvider {
  func placeholder(in context: Context) -> TodayEntry {
    TodayEntry(date: .now, snapshot: nil)
  }

  func getSnapshot(in context: Context, completion: @escaping (TodayEntry) -> Void) {
    completion(TodayEntry(date: .now, snapshot: readSnapshot()))
  }

  /**
   * Now, every five minutes for the countdowns, when the file turns stale, when
   * the five-hour window renews and the next midnight. Relay asks for a reload
   * when what the widgets show changed, and they refresh themselves every 30
   * minutes in case it cannot. Reloads draw on the system's daily budget;
   * entries do not.
   */
  func getTimeline(in context: Context, completion: @escaping (Timeline<TodayEntry>) -> Void) {
    let now = Date.now
    let snapshot = readSnapshot()
    let refresh = now.addingTimeInterval(30 * 60)
    var dates = [now]
    if let snapshot {
      for minutes in stride(from: 5, through: 30, by: 5) {
        dates.append(now.addingTimeInterval(TimeInterval(minutes * 60)))
      }
      let stale = Date(timeIntervalSince1970: snapshot.generatedAt / 1000 + staleAfter)
      if stale > now { dates.append(stale) }
      if let reset = snapshot.active?.fiveHourResetsAt {
        let at = Date(timeIntervalSince1970: reset / 1000)
        if at > now, at < refresh { dates.append(at) }
      }
      if let midnight = nextMidnight(after: now, snapshot.zone) { dates.append(midnight) }
    }
    let entries = Set(dates).sorted().map { TodayEntry(date: $0, snapshot: snapshot) }
    completion(Timeline(entries: entries, policy: .after(refresh)))
  }
}

// MARK: - Look

private extension Color {
  init(hex: UInt32) {
    self.init(
      .sRGB,
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255)
  }
}

/**
 * The widget's colours in its appearance and rendering mode. In full colour,
 * Relay's: the brand orange, amber from 75 % and red from 90 %, and a colour
 * per account. Vibrant (or accented) widgets lose their hue, so there every
 * mark is the primary colour and opacity carries the hierarchy: the figures
 * full, secondary lines about 0.6, tracks and hairlines under 0.2, accounts in
 * the stacked bars in steps; no filled rows.
 */
struct Look {
  var dark = false
  /** Vibrant or accented: no hue. */
  var mono = false

  init() {}
  init(_ scheme: ColorScheme, _ mode: WidgetRenderingMode) {
    dark = scheme == .dark
    mono = mode != .fullColor
  }

  private func pick(_ light: UInt32, _ dark: UInt32) -> Color {
    Color(hex: self.dark ? dark : light)
  }
  private func ink(_ opacity: Double) -> Color { Color.primary.opacity(opacity) }

  var primary: Color { mono ? .primary : pick(0x1D1D1F, 0xF5F5F7) }
  var secondary: Color { mono ? ink(0.62) : pick(0x6E6E73, 0xA1A1A6) }
  var tertiary: Color { mono ? ink(0.42) : pick(0x8E8E93, 0x7C7C80) }
  var hairline: Color { mono ? ink(0.18) : pick(0xE7E4E0, 0x3A393C) }
  var track: Color { mono ? ink(0.2) : pick(0xEFEDE9, 0x3E3C38) }
  var brand: Color { mono ? .primary : pick(0xC2410C, 0xFF8A4C) }
  var warn: Color { mono ? .primary : pick(0xD97706, 0xF5A524) }
  var crit: Color { mono ? .primary : pick(0xD92D20, 0xFF6159) }
  var up: Color { mono ? .primary : pick(0x1F7A3A, 0x4CC873) }
  var down: Color { crit }
  /** The line saying the file is old. */
  var staleLine: Color { mono ? ink(0.62) : pick(0xA14A06, 0xF0A35E) }
  /** Quarter hours still to come. */
  var future: Color { mono ? ink(0.12) : pick(0xE5E2DD, 0x3A3936) }
  /** The suggested account's row: a tint in colour, nothing in vibrant. */
  var suggestedRow: Color { mono ? .clear : brand.opacity(dark ? 0.1 : 0.07) }
  /** The suggested account's Geç. */
  var suggestedButton: Color { mono ? Color.primary.opacity(0.14) : brand.opacity(dark ? 0.16 : 0.12) }
  /** The large widget's account list and the chips. */
  var well: Color { mono ? .clear : pick(0xF6F5F3, 0x2A2A2C) }

  /** A limit's tone by percent used: brand, amber from 75, red from 90. */
  func tone(_ percent: Double?) -> Color {
    guard let percent else { return track }
    return percent >= 90 ? crit : percent >= 75 ? warn : brand
  }
  /** The stacked bars' colours by account order; 3 is the rest. Vibrant: opacity steps. */
  func series(_ index: Int) -> Color {
    if mono { return ink([1, 0.58, 0.34, 0.2][min(max(index, 0), 3)]) }
    switch index {
    case 0: return brand
    case 1: return pick(0x5B7C99, 0x86A6C4)
    case 2: return pick(0xC9C0B4, 0x8C8479)
    default: return pick(0xDDD8D1, 0x55524C)
    }
  }
}

private struct LookKey: EnvironmentKey {
  static let defaultValue = Look()
}

extension EnvironmentValues {
  var look: Look {
    get { self[LookKey.self] }
    set { self[LookKey.self] = newValue }
  }
}

/** Reads the appearance and rendering mode once, for every view below. */
private struct LookReader: ViewModifier {
  @Environment(\.colorScheme) private var scheme
  @Environment(\.widgetRenderingMode) private var mode

  func body(content: Content) -> some View {
    content.environment(\.look, Look(scheme, mode))
  }
}

extension View {
  /** The widget's frame: its look and the system's background. */
  func widgetChrome() -> some View {
    modifier(LookReader()).containerBackground(.background, for: .widget)
  }
}

// MARK: - Panda

/**
 * The panda's heads, from the extension's own Resources (scripts/build-native.mjs
 * copies electron/native/widget/pandas there): the sandbox reads nothing of Relay's
 * but its widget folder, so the images travel in the bundle.
 */
private enum PandaImages {
  // NSCache is thread-safe: WidgetKit may draw several widgets at once.
  nonisolated(unsafe) private static let cache = NSCache<NSString, NSImage>()

  static func image(_ name: String) -> NSImage? {
    if let image = cache.object(forKey: name as NSString) { return image }
    guard let url = Bundle.main.url(forResource: name, withExtension: "png"),
      let image = NSImage(contentsOf: url)
    else { return nil }
    cache.setObject(image, forKey: name as NSString)
    return image
  }
}

/**
 * The panda's head for a mood. In colour it is the mascot; vibrant, a template in
 * the primary colour, whose mask keeps the face the right way round: the dark
 * features solid for dark ink, the cream solid for light ink.
 */
struct Panda: View {
  @Environment(\.look) private var look
  let mood: String
  var size: CGFloat = 22

  var body: some View {
    let name = "panda-\(mood)"
    Group {
      if look.mono, let mask = PandaImages.image("\(name)-mask\(look.dark ? "-dark" : "")") {
        Image(nsImage: mask)
          .renderingMode(.template)
          .resizable()
          .interpolation(.high)
          .foregroundStyle(look.primary)
      } else if let image = PandaImages.image(name) {
        Image(nsImage: image)
          .resizable()
          .interpolation(.high)
      }
    }
    .aspectRatio(468 / 420, contentMode: .fit)
    .frame(width: size, height: size * 420 / 468)
    .accessibilityHidden(true)
  }
}

// MARK: - Rings

/**
 * Two limits as concentric rings, like the app's UsageRing (in a 100 unit box):
 * the outer one the five-hour window, thick, the inner one the week, thin. At
 * 28 pt or less there is one ring. Arcs start at 12 o'clock with round caps.
 */
struct RingGeometry {
  let size: CGFloat
  var single: Bool { size <= 28 }
  var outerWidth: CGFloat { size <= 28 ? 16 : size <= 52 ? 13 : 8 }
  var innerWidth: CGFloat { size <= 52 ? 6 : 3 }
  var gap: CGFloat { size <= 52 ? 3 : 4.5 }
  var outerRadius: CGFloat { 50 - outerWidth / 2 }
  var innerRadius: CGFloat { outerRadius - outerWidth / 2 - gap - innerWidth / 2 }
  /** The clear zone's radius, in the 100 unit box: the innermost ring's inner edge. */
  var clearRadius: CGFloat { single ? outerRadius - outerWidth / 2 : innerRadius - innerWidth / 2 }

  /**
   * A box for text inside the rings, in points: a rectangle inscribed in the
   * clear zone with a margin, wider for one line, taller for two. Text sized
   * to it never touches a ring.
   */
  func labelBox(lines: Int) -> CGSize {
    let radius = clearRadius * size / 100 - max(1.5, size * 0.03)
    let angle = (lines > 1 ? 40.0 : 28.0) * Double.pi / 180
    return CGSize(width: 2 * radius * CGFloat(cos(angle)), height: 2 * radius * CGFloat(sin(angle)))
  }
}

private struct Arc: View {
  let value: Double?
  let radius: CGFloat
  let width: CGFloat
  let scale: CGFloat
  let color: Color
  let track: Color

  var body: some View {
    let diameter = 2 * radius * scale
    let stroke = StrokeStyle(lineWidth: width * scale, lineCap: .round)
    ZStack {
      Circle().stroke(track, lineWidth: width * scale)
      if let value, value > 0 {
        Circle()
          .trim(from: 0, to: CGFloat(min(100, value) / 100))
          .stroke(color, style: stroke)
          .rotationEffect(.degrees(-90))
          .widgetAccentable()
      }
    }
    .frame(width: diameter, height: diameter)
  }
}

struct UsageRing<Label: View>: View {
  @Environment(\.look) private var look
  /** Percent used of the five-hour window (or the one value of a single ring). */
  let outer: Double?
  /** Percent used of the week; nil for a single ring. */
  let inner: Double?
  let size: CGFloat
  /** Quiet arcs: the file is old. */
  var muted = false
  var lines = 1
  @ViewBuilder var label: () -> Label

  var body: some View {
    let ring = RingGeometry(size: size)
    let scale = size / 100
    let color = { (value: Double?) in muted ? look.tertiary : look.tone(value) }
    let box = ring.labelBox(lines: lines)
    ZStack {
      Arc(
        value: outer, radius: ring.outerRadius, width: ring.outerWidth, scale: scale,
        color: color(outer), track: look.track)
      if !ring.single, inner != nil {
        Arc(
          value: inner, radius: ring.innerRadius, width: ring.innerWidth, scale: scale,
          color: color(inner), track: look.track)
      }
      label()
        .frame(width: box.width, height: box.height)
    }
    .frame(width: size, height: size)
  }
}

extension UsageRing where Label == EmptyView {
  init(outer: Double?, inner: Double?, size: CGFloat, muted: Bool = false) {
    self.init(outer: outer, inner: inner, size: size, muted: muted) { EmptyView() }
  }
}

/** The percent in a ring's centre, and below it the time left when the ring has room for two lines. */
private struct RingFigure: View {
  @Environment(\.look) private var look
  let percent: String
  let left: String?
  let size: CGFloat
  var muted = false

  var body: some View {
    VStack(spacing: -1) {
      Text(percent)
        .font(.system(size: size >= 90 ? 21 : size >= 80 ? 19 : 15, weight: .bold))
        .monospacedDigit()
        .foregroundStyle(muted ? look.secondary : look.primary)
      if let left, size >= 80 {
        Text(left)
          .font(.system(size: 11, weight: .medium))
          .monospacedDigit()
          .foregroundStyle(look.secondary)
      }
    }
    .lineLimit(1)
    .minimumScaleFactor(0.5)
  }
}

// MARK: - Charts

/** Today's API value per half hour as bars, with yesterday's average dashed; hours to come as stubs. */
struct SlotBars: View {
  @Environment(\.look) private var look
  let slots: [Double?]
  let average: Double?
  var muted = false

  var body: some View {
    // Two quarter hours to a bar: 48 bars fit a medium widget.
    let bars: [Double?] = stride(from: 0, to: slots.count, by: 2).map { index in
      let a = slots[index]
      let b = index + 1 < slots.count ? slots[index + 1] : nil
      return a == nil && b == nil ? nil : (a ?? 0) + (b ?? 0)
    }
    let mean = average.map { $0 * 2 }
    let peak = max(bars.compactMap { $0 }.max() ?? 0, mean ?? 0, 0.0001)
    GeometryReader { geometry in
      let height = geometry.size.height
      let gap: CGFloat = bars.count > 60 ? 1 : 1.5
      ZStack(alignment: .bottomLeading) {
        HStack(alignment: .bottom, spacing: gap) {
          ForEach(Array(bars.enumerated()), id: \.offset) { _, value in
            UnevenRoundedRectangle(topLeadingRadius: 1.5, topTrailingRadius: 1.5)
              .fill(value == nil ? look.future : muted ? look.tertiary : look.brand)
              .frame(height: value.map { max(1, height * CGFloat($0 / peak)) } ?? max(2, height * 0.05))
              .frame(maxWidth: .infinity)
              .widgetAccentable(value != nil)
          }
        }
        if let mean {
          Path { path in
            let y = height - height * CGFloat(mean / peak)
            path.move(to: CGPoint(x: 0, y: y))
            path.addLine(to: CGPoint(x: geometry.size.width, y: y))
          }
          .stroke(look.mono ? Color.primary.opacity(0.55) : look.tertiary,
                  style: StrokeStyle(lineWidth: 1.2, dash: [3, 2.5]))
        }
      }
    }
  }
}

/** Today's API value as a line, for the small widget: area, line and a dot where it is now. */
struct Sparkline: View {
  @Environment(\.look) private var look
  let slots: [Double?]
  let average: Double?
  var muted = false

  var body: some View {
    GeometryReader { geometry in
      let values = slots.enumerated().compactMap { slot, value in value.map { (slot, $0) } }
      let peak = max(values.map(\.1).max() ?? 0, average ?? 0, 0.0001)
      let width = geometry.size.width - 4
      let height = geometry.size.height - 4
      let x = { (slot: Int) in 2 + CGFloat(slot) / CGFloat(max(1, slots.count - 1)) * width }
      let y = { (value: Double) in 2 + height - CGFloat(value / peak) * height }
      let color = muted ? look.tertiary : look.brand
      ZStack(alignment: .topLeading) {
        if let average {
          Path { path in
            path.move(to: CGPoint(x: 2, y: y(average)))
            path.addLine(to: CGPoint(x: 2 + width, y: y(average)))
          }
          .stroke(look.tertiary, style: StrokeStyle(lineWidth: 1, dash: [3, 2.5]))
        }
        if let first = values.first, let last = values.last {
          Path { path in
            path.move(to: CGPoint(x: x(first.0), y: 2 + height))
            for (slot, value) in values { path.addLine(to: CGPoint(x: x(slot), y: y(value))) }
            path.addLine(to: CGPoint(x: x(last.0), y: 2 + height))
            path.closeSubpath()
          }
          .fill(LinearGradient(
            colors: [color.opacity(look.mono ? 0.28 : 0.22), color.opacity(0)],
            startPoint: .top, endPoint: .bottom))
          Path { path in
            path.move(to: CGPoint(x: x(first.0), y: y(first.1)))
            for (slot, value) in values.dropFirst() { path.addLine(to: CGPoint(x: x(slot), y: y(value))) }
          }
          .stroke(color, style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round))
          .widgetAccentable()
          Circle().fill(color).frame(width: 6, height: 6)
            .position(x: x(last.0), y: y(last.1))
            .widgetAccentable()
        }
      }
    }
  }
}

/** Today's cost split by account, one stacked bar. */
struct SplitBar: View {
  @Environment(\.look) private var look
  let parts: [Snapshot.SplitPart]
  var muted = false

  var body: some View {
    GeometryReader { geometry in
      let gap: CGFloat = 2
      let width = max(0, geometry.size.width - gap * CGFloat(max(0, parts.count - 1)))
      HStack(spacing: gap) {
        ForEach(parts) { part in
          Rectangle()
            .fill(muted ? look.tertiary : look.series(part.color))
            .frame(width: max(2, width * CGFloat(part.share)))
            .widgetAccentable(part.color == 0)
        }
      }
      .frame(width: geometry.size.width, alignment: .leading)
      .clipShape(Capsule())
    }
  }
}

/** Lays its items in lines, wrapping like text; an item wider than a line is offered the line. */
struct Flow: Layout {
  var spacing: CGFloat = 10
  var lineSpacing: CGFloat = 3

  private func rows(_ subviews: Subviews, _ width: CGFloat) -> [(CGPoint, CGSize)] {
    var x: CGFloat = 0
    var y: CGFloat = 0
    var line: CGFloat = 0
    return subviews.map { subview in
      var size = subview.sizeThatFits(.unspecified)
      size.width = min(size.width, width)
      if x > 0, x + size.width > width {
        x = 0
        y += line + lineSpacing
        line = 0
      }
      defer {
        x += size.width + spacing
        line = max(line, size.height)
      }
      return (CGPoint(x: x, y: y), size)
    }
  }

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    let placed = rows(subviews, width)
    let right = placed.map { $0.0.x + $0.1.width }.max() ?? 0
    let bottom = placed.map { $0.0.y + $0.1.height }.max() ?? 0
    return CGSize(width: min(right, width), height: bottom)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    for (subview, (origin, size)) in zip(subviews, rows(subviews, bounds.width)) {
      subview.place(
        at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y),
        proposal: ProposedViewSize(size))
    }
  }
}

/** Each account's colour, name and cost today. */
struct SplitLegend: View {
  @Environment(\.look) private var look
  let parts: [Snapshot.SplitPart]
  var size: CGFloat = 11

  var body: some View {
    Flow(spacing: 10, lineSpacing: 2) {
      ForEach(parts) { part in
        HStack(spacing: 4) {
          RoundedRectangle(cornerRadius: 2).fill(look.series(part.color)).frame(width: 7, height: 7)
          (Text(part.name).foregroundStyle(look.secondary)
            + Text(" ") + Text(part.text.cost).fontWeight(.semibold).foregroundStyle(look.primary))
            .monospacedDigit()
            .lineLimit(1)
        }
      }
    }
    .font(.system(size: size))
  }
}

/** Seven days' cost, stacked by account; today stands out. */
struct WeekBars: View {
  @Environment(\.look) private var look
  let days: [Snapshot.Week.Day]
  var muted = false

  var body: some View {
    let peak = max(days.map(\.cost).max() ?? 0, 0.0001)
    GeometryReader { geometry in
      let height = max(0, geometry.size.height - 15)
      HStack(alignment: .bottom, spacing: 6) {
        ForEach(days) { day in
          VStack(spacing: 3) {
            Spacer(minLength: 0)
            VStack(spacing: 1) {
              ForEach(Array(day.parts.enumerated().reversed()), id: \.offset) { index, cost in
                if cost > 0 {
                  Rectangle()
                    .fill(muted ? look.tertiary : look.series(index))
                    .opacity(index == 0 && !day.today && !look.mono ? 0.85 : 1)
                    .frame(height: max(1.5, height * CGFloat(cost / peak) - 1))
                }
              }
            }
            .frame(maxWidth: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: 2.5))
            // Vibrant: the other days a step back, today accented.
            .opacity(look.mono && !day.today ? 0.7 : 1)
            .widgetAccentable(day.today)
            Text(day.label)
              .font(.system(size: 10, weight: day.today ? .bold : .regular))
              .foregroundStyle(day.today ? look.primary : look.secondary)
              .lineLimit(1)
              .minimumScaleFactor(0.7)
              .frame(height: 12)
          }
        }
      }
    }
  }
}

// MARK: - Pieces

private let turkish = Locale.preferredLanguages.first?.hasPrefix("tr") == true
private func say(_ tr: String, _ en: String) -> String { turkish ? tr : en }

/** `whole` without `part` and the separators around it: "Bugün toplam" from the today line. */
private func without(_ whole: String, _ part: String) -> String {
  guard !part.isEmpty, whole.contains(part) else { return whole }
  return whole.replacingOccurrences(of: part, with: "")
    .trimmingCharacters(in: CharacterSet(charactersIn: " ·").union(.whitespaces))
}

/** A widget with nothing to draw yet: the panda, what it is, and why. */
private struct Message: View {
  @Environment(\.look) private var look
  let title: String
  let line: String
  let mood: String

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Spacer(minLength: 0)
      HStack(alignment: .center, spacing: 10) {
        Panda(mood: mood, size: 40)
        VStack(alignment: .leading, spacing: 2) {
          Text(title).font(.system(size: 13, weight: .bold)).foregroundStyle(look.primary)
          Text(line).font(.system(size: 11)).foregroundStyle(look.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(14)
  }
}

/** What the account widgets show before their content: nil when they can draw it. */
private func blocked(_ entry: TodayEntry) -> Message? {
  guard let snapshot = entry.snapshot else {
    return Message(title: "Relay", line: say("Relay’i aç", "Open Relay"), mood: "sleeping")
  }
  if entry.newDay { return Message(title: snapshot.text.title, line: snapshot.text.empty, mood: entry.mood) }
  if snapshot.state == "scanning" {
    return Message(title: snapshot.text.title, line: snapshot.text.status, mood: entry.mood)
  }
  return nil
}

/** A row's Geç button at its narrowest; a row without one keeps the room, so the costs line up. */
private let switchWidth: CGFloat = 40

/** A Geç button: tinted for the suggested account, outlined for the rest. Opens Relay's review, never switches. */
private struct SwitchButton: View {
  @Environment(\.look) private var look
  let title: String
  let suggested: Bool
  var wide = false

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: 8, style: .continuous)
    let fill: Color = suggested ? look.suggestedButton : .clear
    Text(title)
      .font(.system(size: wide ? 12 : 11.5, weight: .semibold))
      .lineLimit(1)
      .minimumScaleFactor(0.7)
      .padding(.horizontal, wide ? 10 : 6)
      .frame(minWidth: wide ? nil : switchWidth, maxWidth: wide ? .infinity : nil)
      .frame(height: wide ? 28 : 24)
      .foregroundStyle(suggested && !look.mono ? look.brand : look.primary)
      .background(shape.fill(fill))
      .overlay(shape.strokeBorder(suggested && !look.mono ? Color.clear : look.hairline, lineWidth: 1))
  }
}

/** The day's change against yesterday, with its arrow. */
private struct Change: View {
  @Environment(\.look) private var look
  let snapshot: Snapshot
  var size: CGFloat = 11
  var muted = false

  var body: some View {
    if let change = snapshot.change, !snapshot.text.change.isEmpty {
      HStack(spacing: 2) {
        Image(systemName: change >= 0 ? "arrowtriangle.up.fill" : "arrowtriangle.down.fill")
          .font(.system(size: size - 4))
        // The arrow gives the direction: "▲ %50", not "▲ +%50".
        Text(snapshot.text.change.trimmingCharacters(in: CharacterSet(charactersIn: "+-−")))
          .font(.system(size: size, weight: .semibold)).monospacedDigit()
      }
      .foregroundStyle(muted ? look.secondary : change >= 0 ? look.up : look.down)
      .lineLimit(1)
      .fixedSize()
    }
  }
}

/** A label and its value on one line, as the Today and week widgets list them. */
private struct Pair: View {
  @Environment(\.look) private var look
  let label: String
  let value: String

  var body: some View {
    HStack(spacing: 4) {
      Text(label).foregroundStyle(look.secondary)
      Spacer(minLength: 2)
      Text(value).foregroundStyle(look.primary).fontWeight(.medium)
    }
    .font(.system(size: 11))
    .monospacedDigit()
    .lineLimit(1)
  }
}

private struct Hairline: View {
  @Environment(\.look) private var look
  var body: some View { Rectangle().fill(look.hairline).frame(height: 1) }
}

/** "hafta" and "%68" from "hafta %68", the figure drawn bold. */
private func weekShort(_ account: Snapshot.Account, _ look: Look) -> Text {
  let label = without(account.text.weekShort, account.text.week)
  return Text("\(label) ").foregroundStyle(look.secondary)
    + Text(account.text.week).fontWeight(.semibold).foregroundStyle(look.primary)
}

// MARK: - Hesap (small)

struct AccountView: View {
  let entry: TodayEntry

  var body: some View {
    AccountContent(entry: entry)
      .widgetURL(entry.stale ? nil : entry.snapshot?.suggested?.url)
      .widgetChrome()
  }
}

struct AccountContent: View {
  @Environment(\.look) private var look
  let entry: TodayEntry

  var body: some View {
    if let message = blocked(entry) {
      message
    } else if let snapshot = entry.snapshot, let active = snapshot.active {
      content(snapshot, active)
    } else if let snapshot = entry.snapshot {
      Message(title: "Relay", line: snapshot.text.noActive, mood: entry.mood)
    }
  }

  private func content(_ snapshot: Snapshot, _ active: Snapshot.Account) -> some View {
    let muted = entry.stale
    return VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .center, spacing: 4) {
        Text(active.name)
          .font(.system(size: 12.5, weight: .bold))
          .foregroundStyle(look.primary)
          .lineLimit(1)
          .minimumScaleFactor(0.9)
        Spacer(minLength: 2)
        if let left = entry.left {
          Text(left).font(.system(size: 11, weight: .medium)).monospacedDigit()
            .foregroundStyle(look.secondary)
            .fixedSize()
        }
        Panda(mood: entry.mood, size: 18)
      }
      HStack(spacing: 10) {
        UsageRing(outer: active.fiveHour, inner: active.week ?? 0, size: 64, muted: muted) {
          RingFigure(percent: active.text.fiveHour, left: nil, size: 64, muted: muted)
        }
        VStack(alignment: .leading, spacing: 2) {
          Text(active.text.cost)
            .font(.system(size: 17, weight: .bold)).monospacedDigit()
            .foregroundStyle(muted ? look.secondary : look.primary)
            .widgetAccentable()
          Text(active.text.tokensChip ?? active.text.tokens)
            .font(.system(size: 11)).monospacedDigit().foregroundStyle(look.secondary)
          if !active.text.weekShort.isEmpty {
            HStack(spacing: 4) {
              Circle().strokeBorder(muted ? look.tertiary : look.tone(active.week), lineWidth: 1.5)
                .frame(width: 8, height: 8)
              weekShort(active, look).font(.system(size: 11)).monospacedDigit()
            }
          }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.7)
      }
      Spacer(minLength: 0)
      if muted {
        Text(snapshot.text.stale).font(.system(size: 11, weight: .medium))
          .foregroundStyle(look.staleLine).lineLimit(1).minimumScaleFactor(0.8)
      } else if let suggested = snapshot.suggested, let title = suggested.text.switchTo {
        SwitchButton(title: title, suggested: true, wide: true)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 13)
  }
}

// MARK: - Hesaplar (medium) and Hesaplar ve bugün (large)

struct AccountsView: View {
  @Environment(\.widgetFamily) private var family
  let entry: TodayEntry

  var body: some View {
    AccountsContent(entry: entry, large: family == .systemLarge).widgetChrome()
  }
}

/** Another account in the medium widget: its rings, name and limits, today's cost and tokens, and Geç. */
private struct AccountRow: View {
  @Environment(\.look) private var look
  let account: Snapshot.Account
  let switchWord: String
  let muted: Bool

  var body: some View {
    let suggested = account.suggested == true
    HStack(spacing: 7) {
      UsageRing(outer: account.fiveHour, inner: account.week ?? 0, size: 30, muted: muted)
      VStack(alignment: .leading, spacing: 1) {
        Text(account.name).font(.system(size: 12, weight: .semibold)).foregroundStyle(look.primary)
        Text(account.text.limits)
          .font(.system(size: 11)).monospacedDigit().foregroundStyle(look.secondary)
          .minimumScaleFactor(0.85)
      }
      .lineLimit(1)
      Spacer(minLength: 0)
      VStack(alignment: .trailing, spacing: 1) {
        Text(account.text.cost)
          .font(.system(size: 12, weight: .bold)).monospacedDigit()
          .foregroundStyle(muted ? look.secondary : look.primary)
        Text(account.text.tokens)
          .font(.system(size: 11)).monospacedDigit().foregroundStyle(look.secondary)
      }
      .lineLimit(1)
      .fixedSize()
      switchSlot(suggested)
    }
    .padding(.horizontal, 6)
    .padding(.vertical, 5)
    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(suggested ? look.suggestedRow : .clear))
  }

  /** Geç, or the room it takes, so the cost column lines up with its heading. */
  @ViewBuilder private func switchSlot(_ suggested: Bool) -> some View {
    if let url = account.url {
      Link(destination: url) { SwitchButton(title: switchWord, suggested: suggested) }
    } else {
      SwitchButton(title: switchWord, suggested: false).hidden()
    }
  }
}

/** Another account in the large widget: one ring, name, limits with the countdown, cost and Geç. */
private struct LargeRow: View {
  @Environment(\.look) private var look
  let account: Snapshot.Account
  let snapshot: Snapshot
  let date: Date
  let muted: Bool

  var body: some View {
    let suggested = account.suggested == true
    let left = countdown(account.fiveHourResetsAt, at: date)
    let limits = [account.text.fiveHour, account.text.weekShort, left ?? ""]
      .filter { !$0.isEmpty && $0 != "—" }
      .joined(separator: " · ")
    HStack(spacing: 9) {
      UsageRing(outer: account.fiveHour, inner: nil, size: 28, muted: muted)
      VStack(alignment: .leading, spacing: 1) {
        HStack(spacing: 5) {
          Text(account.name).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(look.primary)
          if suggested, let word = snapshot.text.suggested {
            Text(word)
              .font(.system(size: 10, weight: .semibold))
              .foregroundStyle(look.mono ? look.secondary : look.brand)
          }
        }
        Text(limits.isEmpty ? account.text.limits : limits)
          .font(.system(size: 11)).monospacedDigit().foregroundStyle(look.secondary)
      }
      .lineLimit(1)
      Spacer(minLength: 2)
      VStack(alignment: .trailing, spacing: 1) {
        Text(account.text.cost)
          .font(.system(size: 12.5, weight: .bold)).monospacedDigit()
          .foregroundStyle(muted ? look.secondary : look.primary)
        Text(account.text.tokens)
          .font(.system(size: 11)).monospacedDigit().foregroundStyle(look.secondary)
      }
      .lineLimit(1)
      .fixedSize()
      if let url = account.url {
        Link(destination: url) { SwitchButton(title: snapshot.text.switchWord, suggested: suggested) }
      } else {
        SwitchButton(title: snapshot.text.switchWord, suggested: false).hidden()
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background(suggested ? look.suggestedRow : .clear)
  }
}

struct AccountsContent: View {
  @Environment(\.look) private var look
  let entry: TodayEntry
  let large: Bool

  var body: some View {
    if let message = blocked(entry) {
      message
    } else if let snapshot = entry.snapshot {
      if large { self.large(snapshot) } else { medium(snapshot) }
    }
  }

  private var muted: Bool { entry.stale }

  /** "Bugün toplam" and "$91,48 · 86,5 Mn token", shorter where it must be; or the stale line. */
  private func footer(_ snapshot: Snapshot) -> some View {
    let label = Text(without(snapshot.text.todayLine, snapshot.text.costTokens)).foregroundStyle(look.secondary)
    let figure = { (tokens: String) in
      (Text(snapshot.text.cost).fontWeight(.bold).foregroundStyle(look.primary)
        + Text(" · \(tokens)").foregroundStyle(look.secondary))
        .monospacedDigit()
    }
    return VStack(spacing: 4) {
      Hairline()
      Group {
        if muted {
          Text(snapshot.text.stale).foregroundStyle(look.staleLine).fontWeight(.medium)
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
          ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) { label; Spacer(minLength: 4); figure(snapshot.text.tokens ?? snapshot.text.total) }
            HStack(spacing: 6) { label; Spacer(minLength: 4); figure(snapshot.text.total) }
            HStack(spacing: 6) { Spacer(minLength: 0); figure(snapshot.text.total) }
          }
        }
      }
      .font(.system(size: 11))
      .lineLimit(1)
      .padding(.horizontal, 6)
    }
  }

  private func medium(_ snapshot: Snapshot) -> some View {
    HStack(alignment: .center, spacing: 10) {
      VStack(spacing: 5) {
        if let active = snapshot.active {
          UsageRing(outer: active.fiveHour, inner: active.week ?? 0, size: 84, muted: muted, lines: 2) {
            RingFigure(percent: active.text.fiveHour, left: entry.left, size: 84, muted: muted)
          }
          HStack(spacing: 4) {
            Panda(mood: entry.mood, size: 18)
            Text(active.name).font(.system(size: 12, weight: .bold)).foregroundStyle(look.primary)
              .lineLimit(1)
          }
          (Text(active.text.cost).fontWeight(.bold).foregroundStyle(muted ? look.secondary : look.primary)
            + Text(" · \(active.text.tokens)").foregroundStyle(look.secondary))
            .font(.system(size: 11)).monospacedDigit()
            .lineLimit(1).minimumScaleFactor(0.7)
        } else {
          Panda(mood: entry.mood, size: 32)
          Text(snapshot.text.noActive).font(.system(size: 11)).foregroundStyle(look.secondary)
            .multilineTextAlignment(.center)
        }
      }
      .frame(width: 98)
      Rectangle().fill(look.hairline).frame(width: 1).padding(.vertical, 2)
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 7) {
          Text(snapshot.text.others ?? say("Diğer hesaplar", "Other accounts"))
          Spacer(minLength: 0)
          Text(snapshot.text.todayWord ?? say("bugün", "today"))
          // Over the cost column: a hidden Geç takes the room the rows' buttons take.
          SwitchButton(title: snapshot.text.switchWord, suggested: false).hidden().frame(height: 12)
        }
        .font(.system(size: 10.5, weight: .semibold))
        .foregroundStyle(look.secondary)
        .lineLimit(1)
        .padding(.horizontal, 6)
        VStack(spacing: 2) {
          ForEach(snapshot.others.prefix(2)) { account in
            AccountRow(account: account, switchWord: snapshot.text.switchWord, muted: muted)
          }
        }
        Spacer(minLength: 0)
        footer(snapshot)
      }
      .frame(maxWidth: .infinity)
    }
    .padding(.leading, 12)
    .padding(.trailing, 10)
    .padding(.vertical, 12)
  }

  private func large(_ snapshot: Snapshot) -> some View {
    VStack(alignment: .leading, spacing: 11) {
      if let active = snapshot.active {
        HStack(spacing: 14) {
          UsageRing(outer: active.fiveHour, inner: active.week ?? 0, size: 96, muted: muted, lines: 2) {
            RingFigure(percent: active.text.fiveHour, left: entry.left, size: 96, muted: muted)
          }
          VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .center) {
              Text(snapshot.text.inClaude ?? say("Claude’da açık", "Open in Claude"))
                .font(.system(size: 11)).foregroundStyle(look.secondary)
              Spacer(minLength: 4)
              Panda(mood: entry.mood, size: 26)
            }
            Text(active.name).font(.system(size: 16, weight: .bold)).foregroundStyle(look.primary)
              .lineLimit(1)
            if let line = active.text.weekLine, !line.isEmpty {
              Text(line).font(.system(size: 11)).foregroundStyle(look.secondary)
                .lineLimit(1).minimumScaleFactor(0.8)
            }
            HStack(spacing: 6) {
              chip(active.text.cost, active.text.costChip)
              chip(active.text.tokens, active.text.tokensChip)
            }
            .padding(.top, 3)
          }
        }
      } else {
        HStack(spacing: 10) {
          Panda(mood: entry.mood, size: 28)
          Text(snapshot.text.noActive).font(.system(size: 12)).foregroundStyle(look.secondary)
        }
      }
      if !snapshot.others.isEmpty {
        VStack(spacing: 0) {
          ForEach(Array(snapshot.others.prefix(3).enumerated()), id: \.element.id) { index, account in
            if index > 0 { Hairline() }
            LargeRow(account: account, snapshot: snapshot, date: entry.date, muted: muted)
          }
        }
        .background(look.well)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(look.mono ? look.hairline : .clear, lineWidth: 1))
      }
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
          Text(muted ? snapshot.text.stale : snapshot.text.allToday)
            .font(.system(size: 11.5, weight: muted ? .medium : .regular))
            .foregroundStyle(muted ? look.staleLine : look.secondary)
            .lineLimit(1)
          Spacer(minLength: 4)
          Text(snapshot.text.cost)
            .font(.system(size: 16, weight: .bold)).monospacedDigit()
            .foregroundStyle(muted ? look.secondary : look.primary)
            .widgetAccentable()
          Text("· \(snapshot.text.tokens ?? snapshot.text.total)")
            .font(.system(size: 11)).monospacedDigit().foregroundStyle(look.secondary)
          Change(snapshot: snapshot, muted: muted)
        }
        .lineLimit(1)
        .minimumScaleFactor(0.8)
        // The chart takes whatever room fewer accounts leave.
        SlotBars(slots: snapshot.slots, average: snapshot.yesterdayAverage, muted: muted)
          .frame(minHeight: 30, maxHeight: .infinity)
        if let split = snapshot.split, !split.isEmpty {
          SplitBar(parts: split, muted: muted).frame(height: 6)
          SplitLegend(parts: split)
        }
      }
    }
    .padding(16)
  }

  /** "$69,18 bugün": the figure bold, the word quiet. */
  private func chip(_ figure: String, _ whole: String?) -> some View {
    let word = without(whole ?? figure, figure)
    return (Text(figure).fontWeight(.bold).foregroundStyle(look.primary)
      + Text(word.isEmpty ? "" : " \(word)").foregroundStyle(look.secondary))
      .font(.system(size: 11))
      .monospacedDigit()
      .lineLimit(1)
      .padding(.horizontal, 8)
      .padding(.vertical, 3)
      .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(look.well))
      .overlay(
        RoundedRectangle(cornerRadius: 7, style: .continuous)
          .strokeBorder(look.mono ? look.hairline : .clear, lineWidth: 1))
  }
}

// MARK: - Bugün (small, medium)

struct TodayView: View {
  @Environment(\.widgetFamily) private var family
  let entry: TodayEntry

  var body: some View {
    TodayContent(entry: entry, small: family == .systemSmall).widgetChrome()
  }
}

struct TodayContent: View {
  @Environment(\.look) private var look
  let entry: TodayEntry
  let small: Bool

  var body: some View {
    if let snapshot = entry.snapshot {
      if entry.newDay {
        Message(title: snapshot.text.title, line: snapshot.text.empty, mood: entry.mood)
      } else if snapshot.state != "data" {
        Message(title: snapshot.text.title, line: snapshot.text.status, mood: entry.mood)
      } else if small {
        self.small(snapshot)
      } else {
        medium(snapshot)
      }
    } else {
      Message(title: "Relay", line: say("Relay’i aç", "Open Relay"), mood: "sleeping")
    }
  }

  private var muted: Bool { entry.stale }

  private func title(_ text: String) -> some View {
    HStack(alignment: .center, spacing: 4) {
      Text(text)
        .font(.system(size: 11.5, weight: .semibold))
        .foregroundStyle(look.secondary)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
      Spacer(minLength: 2)
      Panda(mood: entry.mood, size: 20)
    }
  }

  private func figure(_ snapshot: Snapshot, size: CGFloat) -> some View {
    Text(snapshot.text.cost)
      .font(.system(size: size, weight: .bold)).monospacedDigit()
      .foregroundStyle(muted ? look.secondary : look.primary)
      .lineLimit(1)
      .minimumScaleFactor(0.6)
      .widgetAccentable()
  }

  /** "Kişisel %94 · 1:50 kaldı", beside the active account's single ring; the stale line once the file is old. */
  @ViewBuilder private func activeLine(_ snapshot: Snapshot) -> some View {
    if muted {
      Text(snapshot.text.stale)
        .font(.system(size: 11, weight: .medium)).foregroundStyle(look.staleLine)
        .lineLimit(1).minimumScaleFactor(0.8)
    } else if let active = snapshot.active, active.fiveHour != nil {
      let line = { (left: String) in
        (Text("\(active.name) \(active.text.fiveHour)").fontWeight(.semibold).foregroundStyle(look.primary)
          + Text(left).foregroundStyle(look.secondary))
          .font(.system(size: 11)).monospacedDigit()
          .lineLimit(1)
      }
      HStack(spacing: 6) {
        UsageRing(outer: active.fiveHour, inner: nil, size: 18)
        // "· 1:50 kaldı", then without "kaldı", then the name and percent alone, shrinking last.
        ViewThatFits(in: .horizontal) {
          if let left = entry.left {
            line(" · \(left) \(snapshot.text.left)")
            line(" · \(left)")
          }
          line("").minimumScaleFactor(0.7)
        }
      }
    }
  }

  private func small(_ snapshot: Snapshot) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      title(snapshot.text.title)
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        figure(snapshot, size: 26).layoutPriority(1)
        Change(snapshot: snapshot, muted: muted)
      }
      .padding(.top, 2)
      Text(snapshot.text.tokens ?? snapshot.text.total)
        .font(.system(size: 12, weight: .semibold)).monospacedDigit()
        .foregroundStyle(look.primary)
        .lineLimit(1)
      Sparkline(slots: snapshot.slots, average: snapshot.yesterdayAverage, muted: muted)
        .frame(minHeight: 22, maxHeight: .infinity)
        .padding(.top, 6)
        .padding(.bottom, 7)
      Hairline()
      activeLine(snapshot).padding(.top, 7)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 13)
  }

  private func medium(_ snapshot: Snapshot) -> some View {
    let values = [snapshot.text.input, snapshot.text.output, snapshot.text.cache]
    let split = snapshot.split ?? []
    return HStack(alignment: .top, spacing: 14) {
      VStack(alignment: .leading, spacing: 0) {
        title(snapshot.text.apiTitle ?? snapshot.text.title)
        figure(snapshot, size: 25).padding(.top, 1)
        HStack(spacing: 5) {
          Text(snapshot.text.tokens ?? snapshot.text.total)
            .font(.system(size: 12, weight: .semibold)).monospacedDigit()
            .foregroundStyle(look.primary)
            .lineLimit(1).minimumScaleFactor(0.8)
          Change(snapshot: snapshot, muted: muted)
        }
        if muted {
          Text(snapshot.text.stale).font(.system(size: 11, weight: .medium))
            .foregroundStyle(look.staleLine).lineLimit(1).minimumScaleFactor(0.8)
            .padding(.top, 2)
        }
        Spacer(minLength: 4)
        VStack(spacing: 2) {
          ForEach(Array(zip(snapshot.text.rows, values)), id: \.0) { label, value in
            Pair(label: label, value: value)
          }
        }
      }
      .frame(width: 126)
      VStack(alignment: .leading, spacing: 5) {
        SlotBars(slots: snapshot.slots, average: snapshot.yesterdayAverage, muted: muted)
          .frame(maxHeight: .infinity)
        HStack {
          ForEach(["00", "06", "12", "18", "24"], id: \.self) { hour in
            Text(hour)
            if hour != "24" { Spacer(minLength: 0) }
          }
        }
        .font(.system(size: 10)).monospacedDigit()
        .foregroundStyle(look.secondary)
        if !split.isEmpty {
          SplitBar(parts: split, muted: muted).frame(height: 5).padding(.top, 1)
          SplitLegend(parts: split, size: 10.5)
        }
      }
      .frame(maxWidth: .infinity)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 13)
  }
}

// MARK: - Son 7 gün (medium)

struct WeekView: View {
  let entry: TodayEntry

  var body: some View {
    WeekContent(entry: entry).widgetChrome()
  }
}

struct WeekContent: View {
  @Environment(\.look) private var look
  let entry: TodayEntry

  var body: some View {
    if let message = blocked(entry) {
      message
    } else if let snapshot = entry.snapshot, let week = snapshot.week {
      content(snapshot, week)
    } else {
      Message(title: "Relay", line: say("Relay’i aç", "Open Relay"), mood: "sleeping")
    }
  }

  /**
   * "En yoğun Sal · $142,10" as "En yoğun" and "Sal · $142,10" on either side, like the design's
   * pairs; a line whose figure does not end it ("$58.90 a day") reads as one, the figure bold.
   */
  @ViewBuilder private func pair(_ line: String) -> some View {
    if let end = line.range(of: #"(\S+ · )?[≈$€£]?\d[\d.,]*[×%]?$"#, options: .regularExpression),
      end.lowerBound > line.startIndex
    {
      Pair(
        label: String(line[..<end.lowerBound]).trimmingCharacters(in: .whitespaces),
        value: String(line[end]))
    } else if let figure = line.range(of: #"[≈$€£]\d[\d.,]*"#, options: .regularExpression) {
      (Text(line[..<figure.lowerBound]).foregroundStyle(look.secondary)
        + Text(line[figure]).fontWeight(.medium).foregroundStyle(look.primary)
        + Text(line[figure.upperBound...]).foregroundStyle(look.secondary))
        .font(.system(size: 11)).monospacedDigit().lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
    } else {
      Text(line).font(.system(size: 11)).foregroundStyle(look.secondary).lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func content(_ snapshot: Snapshot, _ week: Snapshot.Week) -> some View {
    let muted = entry.stale
    return HStack(alignment: .top, spacing: 14) {
      VStack(alignment: .leading, spacing: 0) {
        HStack(alignment: .center, spacing: 4) {
          Text(week.text.title)
            .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(look.secondary)
            .lineLimit(1)
          Spacer(minLength: 2)
          Panda(mood: entry.mood, size: 20)
        }
        Text(week.text.cost)
          .font(.system(size: 25, weight: .bold)).monospacedDigit()
          .foregroundStyle(muted ? look.secondary : look.primary)
          .lineLimit(1).minimumScaleFactor(0.6)
          .widgetAccentable()
          .padding(.top, 1)
        Text(week.text.tokens)
          .font(.system(size: 12, weight: .semibold)).monospacedDigit()
          .foregroundStyle(look.primary)
          .lineLimit(1)
        if muted {
          Text(snapshot.text.stale).font(.system(size: 11, weight: .medium))
            .foregroundStyle(look.staleLine).lineLimit(1).minimumScaleFactor(0.8)
            .padding(.top, 2)
        }
        Spacer(minLength: 4)
        VStack(spacing: 2) {
          pair(week.text.average)
          if !week.text.busiest.isEmpty { pair(week.text.busiest) }
          if !week.text.hits.isEmpty { pair(week.text.hits) }
        }
        .minimumScaleFactor(0.8)
      }
      .frame(width: 126)
      VStack(alignment: .leading, spacing: 6) {
        WeekBars(days: week.days, muted: muted)
        if let active = snapshot.active, active.week != nil, !week.text.activeWeek.isEmpty {
          HStack(spacing: 6) {
            UsageRing(outer: active.week, inner: nil, size: 16, muted: muted)
            (Text("\(active.name) · ").foregroundStyle(look.secondary)
              + weekShort(active, look)
              + Text(active.text.weekReset.isEmpty ? "" : " · \(active.text.weekReset)")
              .foregroundStyle(look.secondary))
              .font(.system(size: 11)).monospacedDigit()
              .lineLimit(1).minimumScaleFactor(0.75)
          }
        }
      }
      .frame(maxWidth: .infinity)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 13)
  }
}

// MARK: - Widgets

struct RelayAccount: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RelayAccount", provider: TodayProvider()) { entry in
      AccountView(entry: entry)
    }
    .configurationDisplayName(say("Relay · Hesap", "Relay · Account"))
    .description(
      say(
        "Açık hesabın limitleri, bugünkü maliyeti ve tokenları",
        "The open account’s limits, cost and tokens today"))
    .supportedFamilies([.systemSmall])
    .contentMarginsDisabled()
  }
}

struct RelayAccounts: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RelayAccounts", provider: TodayProvider()) { entry in
      AccountsView(entry: entry)
    }
    .configurationDisplayName(say("Relay · Hesaplar", "Relay · Accounts"))
    .description(
      say(
        "Hesapların limitleri ve bugünkü maliyeti; Geç düğmesi Relay’de geçiş onayını açar",
        "Your accounts’ limits and cost today; Switch opens the switch review in Relay"))
    .supportedFamilies([.systemMedium])
    .contentMarginsDisabled()
  }
}

struct RelayAccountsToday: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RelayAccountsToday", provider: TodayProvider()) { entry in
      AccountsView(entry: entry)
    }
    .configurationDisplayName(say("Relay · Hesaplar ve bugün", "Relay · Accounts and today"))
    .description(
      say(
        "Hesapların limitleri, bugünkü maliyeti, tokenları ve hesaplara dağılımı",
        "Your accounts’ limits, and today’s cost, tokens and split by account"))
    .supportedFamilies([.systemLarge])
    .contentMarginsDisabled()
  }
}

struct RelayToday: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RelayToday", provider: TodayProvider()) { entry in
      TodayView(entry: entry)
    }
    .configurationDisplayName(say("Relay · Bugün", "Relay · Today"))
    .description(
      say(
        "Bugünkü Claude Code tokenları ve API karşılığı",
        "Today’s Claude Code tokens and their API value"))
    .supportedFamilies([.systemSmall, .systemMedium])
    .contentMarginsDisabled()
  }
}

struct RelayWeek: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RelayWeek", provider: TodayProvider()) { entry in
      WeekView(entry: entry)
    }
    .configurationDisplayName(say("Relay · Son 7 gün", "Relay · Last 7 days"))
    .description(
      say(
        "Son yedi günün maliyeti, tokenları ve hesaplara dağılımı",
        "The last seven days’ cost, tokens and split by account"))
    .supportedFamilies([.systemMedium])
    .contentMarginsDisabled()
  }
}

@main
struct RelayWidgets: WidgetBundle {
  var body: some Widget {
    RelayAccount()
    RelayAccounts()
    RelayAccountsToday()
    RelayToday()
    RelayWeek()
  }
}
