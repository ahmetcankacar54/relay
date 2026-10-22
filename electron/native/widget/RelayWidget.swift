// Relay's macOS widgets: the account open in Claude with its limits, the other
// accounts, and today's and the week's Claude Code tokens with their API value.
// Relay writes ~/Library/Application Support/Relay/widget/today.json with every
// string already formatted; this extension only reads and draws it. Built by
// scripts/build-native.mjs with -e _NSExtensionMain (without it chronod starts
// the extension and it exits: "Unrecognized extension type").
//
// A widget never switches accounts. Its Geç buttons open relay://switch links:
// Relay shows its usual switch review for that account, and nothing more.
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

    enum CodingKeys: String, CodingKey {
      case title, subtitle, rows, input, output, cache, total, cost, change, status, empty, stale
      case costTokens, todayLine, allToday, left, noActive
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

// MARK: - Colours

private extension Color {
  init(hex: UInt32) {
    self.init(
      .sRGB,
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255)
  }
}

/** Relay's colours in the widget's appearance. */
struct Palette {
  let dark: Bool
  init(_ scheme: ColorScheme) { dark = scheme == .dark }

  private func pick(_ light: UInt32, _ dark: UInt32) -> Color {
    Color(hex: self.dark ? dark : light)
  }
  var brand: Color { pick(0xC2410C, 0xFF8A4C) }
  var warn: Color { Color(hex: 0xD97706) }
  var crit: Color { Color(hex: 0xD92D20) }
  var track: Color { pick(0xEFEDE9, 0x3E3C38) }
  /** The suggested account's row. */
  var suggestedRow: Color { pick(0xFFF4EC, 0x3A2416) }
  var onBrand: Color { dark ? Color(hex: 0x1C1917) : .white }

  /** A limit's tone by percent used: brand, warning from 75, critical from 90. */
  func tone(_ percent: Double?) -> Color {
    guard let percent else { return track }
    return percent >= 90 ? crit : percent >= 75 ? warn : brand
  }
  /** The stacked bars' colours, by account order; 3 is the rest. */
  func series(_ index: Int) -> Color {
    switch index {
    case 0: return brand
    case 1: return pick(0x5B7C99, 0x86A6C4)
    case 2: return pick(0xC9C0B4, 0x8C8479)
    default: return pick(0xE4E0DA, 0x4E4B46)
    }
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
      }
    }
    .frame(width: diameter, height: diameter)
  }
}

struct UsageRing<Label: View>: View {
  @Environment(\.colorScheme) private var scheme
  /** Percent used of the five-hour window (or the one value of a single ring). */
  let outer: Double?
  /** Percent used of the week; nil for a single ring. */
  let inner: Double?
  let size: CGFloat
  /** Grey arcs: the file is old. */
  var muted = false
  var lines = 1
  @ViewBuilder var label: () -> Label

  var body: some View {
    let palette = Palette(scheme)
    let ring = RingGeometry(size: size)
    let scale = size / 100
    let color = { (value: Double?) in muted ? Color.secondary : palette.tone(value) }
    let box = ring.labelBox(lines: lines)
    ZStack {
      Arc(
        value: outer, radius: ring.outerRadius, width: ring.outerWidth, scale: scale,
        color: color(outer), track: palette.track)
      if !ring.single, inner != nil {
        Arc(
          value: inner, radius: ring.innerRadius, width: ring.innerWidth, scale: scale,
          color: color(inner), track: palette.track)
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

/** The percent, and below it the time left when the ring is large enough for two lines. */
private struct RingFigure: View {
  let percent: String
  let left: String?
  let size: CGFloat
  var muted = false

  var body: some View {
    VStack(spacing: 0) {
      Text(percent)
        .font(.system(size: size >= 90 ? 19 : size >= 80 ? 16 : 14, weight: .bold))
        .monospacedDigit()
        .foregroundStyle(muted ? Color.secondary : Color.primary)
      if let left, size >= 80 {
        Text(left)
          .font(.system(size: 10, weight: .medium))
          .monospacedDigit()
          .foregroundStyle(.secondary)
      }
    }
    .lineLimit(1)
    .minimumScaleFactor(0.5)
  }
}

// MARK: - Charts

/** The API value per quarter hour, with yesterday's average dashed. */
struct TodayLine: View {
  let slots: [Double?]
  let average: Double?
  let color: Color
  var ticks = false

  var body: some View {
    GeometryReader { geometry in
      let values = slots.enumerated().compactMap { slot, value in value.map { (slot, $0) } }
      let peak = max(values.map(\.1).max() ?? 0, average ?? 0)
      let width = geometry.size.width
      let height = geometry.size.height - (ticks ? 12 : 0)
      let x = { (slot: Int) in CGFloat(slot) / 95 * width }
      let y = { (value: Double) in peak > 0 ? height - CGFloat(value / peak) * (height - 2) : height }
      ZStack(alignment: .topLeading) {
        if ticks {
          ForEach([24, 48, 72], id: \.self) { slot in
            Path { path in
              path.move(to: CGPoint(x: x(slot), y: 0))
              path.addLine(to: CGPoint(x: x(slot), y: height))
            }
            .stroke(Color.secondary.opacity(0.25), lineWidth: 0.5)
            Text("\(slot / 4)")
              .font(.system(size: 9))
              .foregroundStyle(.secondary)
              .position(x: x(slot), y: height + 7)
          }
        }
        if let average {
          Path { path in
            path.move(to: CGPoint(x: 0, y: y(average)))
            path.addLine(to: CGPoint(x: width, y: y(average)))
          }
          .stroke(Color.secondary.opacity(0.7), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
        }
        if let first = values.first, let last = values.last {
          Path { path in
            path.move(to: CGPoint(x: x(first.0), y: height))
            for (slot, value) in values { path.addLine(to: CGPoint(x: x(slot), y: y(value))) }
            path.addLine(to: CGPoint(x: x(last.0), y: height))
            path.closeSubpath()
          }
          .fill(
            LinearGradient(
              colors: [color.opacity(0.35), color.opacity(0.02)],
              startPoint: .top, endPoint: .bottom))
          Path { path in
            path.move(to: CGPoint(x: x(first.0), y: y(first.1)))
            for (slot, value) in values.dropFirst() {
              path.addLine(to: CGPoint(x: x(slot), y: y(value)))
            }
          }
          .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineJoin: .round))
        }
      }
    }
  }
}

/** Today's cost split by account, one stacked bar. */
struct SplitBar: View {
  @Environment(\.colorScheme) private var scheme
  let parts: [Snapshot.SplitPart]
  var muted = false

  var body: some View {
    let palette = Palette(scheme)
    GeometryReader { geometry in
      let gaps = CGFloat(max(0, parts.count - 1))
      let width = max(0, geometry.size.width - gaps)
      HStack(spacing: 1) {
        ForEach(parts) { part in
          Rectangle()
            .fill(muted ? Color.secondary.opacity(0.4) : palette.series(part.color))
            .frame(width: max(2, width * CGFloat(part.share)))
        }
      }
      .frame(width: geometry.size.width, alignment: .leading)
      .clipShape(Capsule())
    }
  }
}

/** Each account's colour, name and cost today. */
struct SplitLegend: View {
  @Environment(\.colorScheme) private var scheme
  let parts: [Snapshot.SplitPart]
  var limit = 4

  var body: some View {
    let palette = Palette(scheme)
    HStack(spacing: 8) {
      ForEach(parts.prefix(limit)) { part in
        HStack(spacing: 3) {
          Circle().fill(palette.series(part.color)).frame(width: 6, height: 6)
          Text(part.name).lineLimit(1).truncationMode(.tail)
          Text(part.text.cost).monospacedDigit().lineLimit(1).layoutPriority(1)
        }
      }
      Spacer(minLength: 0)
    }
    .font(.system(size: 9))
    .foregroundStyle(.secondary)
  }
}

/** Seven days' cost, stacked by account; today stands out. */
struct WeekBars: View {
  @Environment(\.colorScheme) private var scheme
  let days: [Snapshot.Week.Day]
  var muted = false

  var body: some View {
    let palette = Palette(scheme)
    let peak = max(days.map(\.cost).max() ?? 0, 0.0001)
    GeometryReader { geometry in
      let height = max(0, geometry.size.height - 14)
      HStack(alignment: .bottom, spacing: 5) {
        ForEach(days) { day in
          VStack(spacing: 2) {
            Spacer(minLength: 0)
            VStack(spacing: 0) {
              ForEach(Array(day.parts.enumerated().reversed()), id: \.offset) { index, cost in
                if cost > 0 {
                  Rectangle()
                    .fill(muted ? Color.secondary.opacity(0.5) : palette.series(index))
                    .frame(height: max(1, height * CGFloat(cost / peak)))
                }
              }
            }
            .frame(maxWidth: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: 2))
            .opacity(day.today ? 1 : 0.6)
            Text(day.label)
              .font(.system(size: 9, weight: day.today ? .bold : .regular))
              .foregroundStyle(day.today ? Color.primary : Color.secondary)
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

/** A widget with nothing to draw yet: what it is, and why. */
private struct Message: View {
  let title: String
  let line: String

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title).font(.headline)
      Text(line).font(.caption).foregroundStyle(.secondary)
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/** What the account widgets show before their content: nil when they can draw it. */
private func blocked(_ entry: TodayEntry) -> (String, String)? {
  guard let snapshot = entry.snapshot else { return ("Relay", say("Relay'i açın", "Open Relay")) }
  if entry.newDay { return (snapshot.text.title, snapshot.text.empty) }
  if snapshot.state == "scanning" { return (snapshot.text.title, snapshot.text.status) }
  return nil
}

/** A Geç button: filled for the suggested account. Opens Relay's review, never switches. */
private struct SwitchButton: View {
  @Environment(\.colorScheme) private var scheme
  let title: String
  let filled: Bool
  var wide = false

  var body: some View {
    let palette = Palette(scheme)
    Text(title)
      .font(.system(size: wide ? 11 : 10, weight: .semibold))
      .lineLimit(1)
      .minimumScaleFactor(0.7)
      .padding(.horizontal, wide ? 8 : 7)
      .padding(.vertical, wide ? 5 : 3)
      .frame(maxWidth: wide ? .infinity : nil)
      .foregroundStyle(filled ? palette.onBrand : palette.brand)
      .background(Capsule().fill(filled ? palette.brand : Color.clear))
      .overlay(Capsule().strokeBorder(palette.brand, lineWidth: filled ? 0 : 1))
  }
}

/** Another account: its rings, name and limits, today's cost and tokens, and Geç. */
private struct AccountRow: View {
  @Environment(\.colorScheme) private var scheme
  let account: Snapshot.Account
  let switchWord: String
  let muted: Bool

  var body: some View {
    let palette = Palette(scheme)
    let suggested = account.suggested == true
    HStack(spacing: 6) {
      UsageRing(outer: account.fiveHour, inner: account.week ?? 0, size: 30, muted: muted)
      VStack(alignment: .leading, spacing: 1) {
        Text(account.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
        Text(account.text.limits)
          .font(.system(size: 10)).monospacedDigit().foregroundStyle(.secondary).lineLimit(1)
      }
      Spacer(minLength: 4)
      VStack(alignment: .trailing, spacing: 1) {
        Text(account.text.cost)
          .font(.system(size: 11, weight: .semibold)).monospacedDigit()
          .foregroundStyle(muted ? Color.secondary : Color.primary)
        Text(account.text.tokens)
          .font(.system(size: 10)).monospacedDigit().foregroundStyle(.secondary)
      }
      .lineLimit(1)
      .layoutPriority(1)
      if let url = account.url {
        Link(destination: url) { SwitchButton(title: switchWord, filled: suggested) }
      }
    }
    .padding(.horizontal, 6)
    .padding(.vertical, 3)
    .background(
      RoundedRectangle(cornerRadius: 8).fill(suggested ? palette.suggestedRow : Color.clear))
  }
}

private struct Chip: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.system(size: 10, weight: .medium))
      .monospacedDigit()
      .lineLimit(1)
      .minimumScaleFactor(0.7)
      .padding(.horizontal, 6)
      .padding(.vertical, 2)
      .background(Capsule().fill(Color.secondary.opacity(0.12)))
  }
}

/** The day's change against yesterday, with its arrow. */
private struct Change: View {
  let snapshot: Snapshot
  var size: CGFloat = 11

  var body: some View {
    if let change = snapshot.change, !snapshot.text.change.isEmpty {
      HStack(spacing: 2) {
        Image(systemName: change >= 0 ? "arrowtriangle.up.fill" : "arrowtriangle.down.fill")
          .font(.system(size: size - 3))
        Text(snapshot.text.change).font(.system(size: size, weight: .bold)).monospacedDigit()
      }
      .foregroundStyle(change >= 0 ? Color.green : Color.red)
      .lineLimit(1)
    }
  }
}

// MARK: - Hesap (small)

struct AccountView: View {
  @Environment(\.colorScheme) private var scheme
  let entry: TodayEntry

  var body: some View {
    Group {
      if let message = blocked(entry) {
        Message(title: message.0, line: message.1)
      } else if let snapshot = entry.snapshot, let active = snapshot.active {
        content(snapshot, active)
      } else if let snapshot = entry.snapshot {
        Message(title: "Relay", line: snapshot.text.noActive)
      }
    }
    .widgetURL(entry.stale ? nil : entry.snapshot?.suggested?.url)
    .containerBackground(.background, for: .widget)
  }

  private func content(_ snapshot: Snapshot, _ active: Snapshot.Account) -> some View {
    let palette = Palette(scheme)
    let muted = entry.stale
    return VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 4) {
        Text(active.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
        Spacer(minLength: 4)
        if let left = entry.left {
          Text(left).font(.system(size: 11, weight: .medium)).monospacedDigit()
            .foregroundStyle(.secondary)
        }
      }
      HStack(spacing: 9) {
        UsageRing(outer: active.fiveHour, inner: active.week ?? 0, size: 64, muted: muted) {
          RingFigure(percent: active.text.fiveHour, left: nil, size: 64, muted: muted)
        }
        VStack(alignment: .leading, spacing: 2) {
          Text(active.text.cost)
            .font(.system(size: 15, weight: .bold)).monospacedDigit()
            .foregroundStyle(muted ? Color.secondary : Color.primary)
          Text(active.text.tokensChip ?? active.text.tokens)
            .font(.system(size: 11)).monospacedDigit().foregroundStyle(.secondary)
          if !active.text.weekShort.isEmpty {
            HStack(spacing: 4) {
              Circle().strokeBorder(muted ? Color.secondary : palette.tone(active.week), lineWidth: 1.5)
                .frame(width: 7, height: 7)
              Text(active.text.weekShort).font(.system(size: 11)).monospacedDigit()
            }
          }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.7)
      }
      Spacer(minLength: 0)
      if muted {
        Text(snapshot.text.stale).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
      } else if let suggested = snapshot.suggested, let title = suggested.text.switchTo {
        SwitchButton(title: title, filled: true, wide: true)
      }
    }
  }
}

// MARK: - Hesaplar (medium) and Hesaplar ve bugün (large)

struct AccountsView: View {
  @Environment(\.colorScheme) private var scheme
  @Environment(\.widgetFamily) private var family
  let entry: TodayEntry

  var body: some View {
    Group {
      if let message = blocked(entry) {
        Message(title: message.0, line: message.1)
      } else if let snapshot = entry.snapshot {
        if family == .systemLarge { large(snapshot) } else { medium(snapshot) }
      }
    }
    .containerBackground(.background, for: .widget)
  }

  private var muted: Bool { entry.stale }

  private func rows(_ snapshot: Snapshot, _ count: Int) -> some View {
    VStack(spacing: 4) {
      ForEach(snapshot.others.prefix(count)) { account in
        AccountRow(account: account, switchWord: snapshot.text.switchWord, muted: muted)
      }
    }
  }

  private func footer(_ snapshot: Snapshot, _ line: String) -> some View {
    Text(muted ? snapshot.text.stale : line)
      .font(.system(size: 10)).monospacedDigit()
      .foregroundStyle(.secondary)
      .lineLimit(1).minimumScaleFactor(0.7)
  }

  private func medium(_ snapshot: Snapshot) -> some View {
    HStack(alignment: .top, spacing: 10) {
      VStack(spacing: 4) {
        if let active = snapshot.active {
          UsageRing(outer: active.fiveHour, inner: active.week ?? 0, size: 84, muted: muted, lines: 2) {
            RingFigure(percent: active.text.fiveHour, left: entry.left, size: 84, muted: muted)
          }
          Text(active.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
          Text(active.text.costTokens)
            .font(.system(size: 10)).monospacedDigit().foregroundStyle(.secondary)
            .lineLimit(1).minimumScaleFactor(0.7)
        } else {
          Text(snapshot.text.noActive).font(.caption).foregroundStyle(.secondary)
        }
        Spacer(minLength: 0)
      }
      .frame(width: 104)
      VStack(alignment: .leading, spacing: 4) {
        rows(snapshot, 2)
        Spacer(minLength: 0)
        footer(snapshot, snapshot.text.todayLine)
      }
      .frame(maxWidth: .infinity)
    }
  }

  private func large(_ snapshot: Snapshot) -> some View {
    VStack(alignment: .leading, spacing: 7) {
      if let active = snapshot.active {
        HStack(spacing: 12) {
          UsageRing(outer: active.fiveHour, inner: active.week ?? 0, size: 96, muted: muted, lines: 2) {
            RingFigure(percent: active.text.fiveHour, left: entry.left, size: 96, muted: muted)
          }
          VStack(alignment: .leading, spacing: 4) {
            Text(active.name).font(.system(size: 15, weight: .semibold)).lineLimit(1)
            if let line = active.text.weekLine, !line.isEmpty {
              Text(line).font(.system(size: 11)).foregroundStyle(.secondary)
                .lineLimit(1).minimumScaleFactor(0.8)
            }
            HStack(spacing: 5) {
              Chip(text: active.text.costChip ?? active.text.cost)
              Chip(text: active.text.tokensChip ?? active.text.tokens)
            }
          }
          Spacer(minLength: 0)
        }
      } else {
        Text(snapshot.text.noActive).font(.caption).foregroundStyle(.secondary)
      }
      rows(snapshot, 3)
      Divider()
      HStack(spacing: 6) {
        Text(snapshot.text.allToday).font(.system(size: 11, weight: .semibold)).lineLimit(1)
        Spacer(minLength: 4)
        Text(snapshot.text.costTokens)
          .font(.system(size: 11)).monospacedDigit()
          .foregroundStyle(muted ? Color.secondary : Color.primary)
          .lineLimit(1).minimumScaleFactor(0.7)
        Change(snapshot: snapshot)
      }
      TodayLine(
        slots: snapshot.slots, average: snapshot.yesterdayAverage,
        color: muted ? .secondary : Palette(scheme).brand
      )
      // The chart takes whatever room fewer accounts leave.
      .frame(minHeight: 36, maxHeight: .infinity)
      if let split = snapshot.split, !split.isEmpty {
        SplitBar(parts: split, muted: muted).frame(height: 6)
        SplitLegend(parts: split)
      }
      if muted { footer(snapshot, "") }
    }
  }
}

// MARK: - Bugün (small, medium)

struct TodayView: View {
  @Environment(\.colorScheme) private var scheme
  @Environment(\.widgetFamily) var family
  let entry: TodayEntry

  var body: some View {
    Group {
      if let snapshot = entry.snapshot {
        if entry.newDay {
          Message(title: snapshot.text.title, line: snapshot.text.empty)
        } else if snapshot.state != "data" {
          Message(title: snapshot.text.title, line: snapshot.text.status)
        } else if family == .systemSmall {
          small(snapshot)
        } else {
          medium(snapshot)
        }
      } else {
        Message(title: "Relay", line: say("Relay'i açın", "Open Relay"))
      }
    }
    .containerBackground(.background, for: .widget)
  }

  private func tone(_ snapshot: Snapshot) -> Color {
    guard let change = snapshot.change else { return .primary }
    return change >= 0 ? .green : .red
  }
  private func lineColor(_ snapshot: Snapshot) -> Color {
    entry.stale ? .secondary : tone(snapshot) == .primary ? .green : tone(snapshot)
  }

  private func header(_ snapshot: Snapshot) -> some View {
    HStack(spacing: 4) {
      Text(snapshot.text.title).font(.headline)
      Spacer(minLength: 4)
      Change(snapshot: snapshot)
    }
  }

  private func subtitle(_ snapshot: Snapshot) -> some View {
    Text(entry.stale ? snapshot.text.stale : snapshot.text.subtitle)
      .font(.caption2)
      .foregroundStyle(.secondary)
      .lineLimit(1)
  }

  /** "Kişisel %94 · 1:50 kaldı", beside the active account's single ring. */
  @ViewBuilder private func activeLine(_ snapshot: Snapshot) -> some View {
    if let active = snapshot.active, active.fiveHour != nil {
      let left = entry.left.map { " · \($0) \(snapshot.text.left)" } ?? ""
      HStack(spacing: 5) {
        UsageRing(outer: active.fiveHour, inner: nil, size: 18, muted: entry.stale)
        Text("\(active.name) \(active.text.fiveHour)\(left)")
          .font(.system(size: 10)).monospacedDigit()
          .lineLimit(1).minimumScaleFactor(0.7)
      }
    }
  }

  private func small(_ snapshot: Snapshot) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      header(snapshot)
      subtitle(snapshot)
      Spacer(minLength: 2)
      HStack(alignment: .firstTextBaseline, spacing: 4) {
        Text(snapshot.text.cost)
          .font(.title2.bold()).monospacedDigit()
          .foregroundStyle(entry.stale ? Color.secondary : tone(snapshot))
          .layoutPriority(1)
        Text(snapshot.text.total)
          .font(.caption).monospacedDigit().foregroundStyle(.secondary)
      }
      .lineLimit(1)
      .minimumScaleFactor(0.6)
      TodayLine(slots: snapshot.slots, average: snapshot.yesterdayAverage, color: lineColor(snapshot))
        .frame(height: snapshot.active?.fiveHour == nil ? 28 : 20)
      activeLine(snapshot).padding(.top, 2)
    }
  }

  private func medium(_ snapshot: Snapshot) -> some View {
    let values = [snapshot.text.input, snapshot.text.output, snapshot.text.cache]
    let split = snapshot.split ?? []
    return VStack(alignment: .leading, spacing: 5) {
      HStack(alignment: .top, spacing: 14) {
        VStack(alignment: .leading, spacing: 1) {
          Text(snapshot.text.title).font(.headline)
          subtitle(snapshot)
          Spacer(minLength: 2)
          ForEach(Array(zip(snapshot.text.rows, values)), id: \.0) { label, value in
            HStack {
              Text(label).foregroundStyle(.secondary)
              Spacer()
              Text(value).monospacedDigit()
            }
            .font(.system(size: 10))
          }
          Spacer(minLength: 2)
          Text(snapshot.text.total)
            .font(.title2.bold()).monospacedDigit()
            .foregroundStyle(entry.stale ? Color.secondary : Color.primary)
            .minimumScaleFactor(0.6).lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        VStack(alignment: .trailing, spacing: 2) {
          HStack(spacing: 6) {
            Change(snapshot: snapshot, size: 12)
            Spacer(minLength: 2)
            Text(snapshot.text.cost)
              .font(.title3.bold()).monospacedDigit()
              .foregroundStyle(entry.stale ? Color.secondary : tone(snapshot))
              .minimumScaleFactor(0.6).lineLimit(1)
          }
          TodayLine(
            slots: snapshot.slots, average: snapshot.yesterdayAverage,
            color: lineColor(snapshot), ticks: true
          )
          .padding(.top, 2)
        }
        .frame(maxWidth: .infinity)
      }
      if !split.isEmpty {
        SplitBar(parts: split, muted: entry.stale).frame(height: 5)
        SplitLegend(parts: split)
      }
    }
  }
}

// MARK: - Son 7 gün (medium)

struct WeekView: View {
  let entry: TodayEntry

  var body: some View {
    Group {
      if let message = blocked(entry) {
        Message(title: message.0, line: message.1)
      } else if let snapshot = entry.snapshot, let week = snapshot.week {
        content(snapshot, week)
      } else {
        Message(title: "Relay", line: say("Relay'i açın", "Open Relay"))
      }
    }
    .containerBackground(.background, for: .widget)
  }

  private func content(_ snapshot: Snapshot, _ week: Snapshot.Week) -> some View {
    let muted = entry.stale
    return HStack(alignment: .top, spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(week.text.title).font(.headline).lineLimit(1)
        Text(week.text.cost)
          .font(.system(size: 20, weight: .bold)).monospacedDigit()
          .foregroundStyle(muted ? Color.secondary : Color.primary)
        Text(week.text.tokens).font(.system(size: 11)).monospacedDigit().foregroundStyle(.secondary)
        Spacer(minLength: 2)
        Group {
          Text(week.text.average)
          if !week.text.busiest.isEmpty { Text(week.text.busiest) }
          if !week.text.hits.isEmpty { Text(week.text.hits) }
          if muted { Text(snapshot.text.stale) }
        }
        .font(.system(size: 10)).monospacedDigit().foregroundStyle(.secondary)
      }
      .lineLimit(1)
      .minimumScaleFactor(0.7)
      .frame(width: 124, alignment: .leading)
      VStack(alignment: .leading, spacing: 4) {
        WeekBars(days: week.days, muted: muted)
        if let active = snapshot.active, active.week != nil, !week.text.activeWeek.isEmpty {
          HStack(spacing: 5) {
            UsageRing(outer: active.week, inner: nil, size: 16, muted: muted)
            Text(week.text.activeWeek)
              .font(.system(size: 10)).monospacedDigit()
              .lineLimit(1).minimumScaleFactor(0.7)
          }
        }
      }
    }
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
        "Açık hesabın limitleri, bugünkü maliyeti ve token’ları",
        "The open account's limits, cost and tokens today"))
    .supportedFamilies([.systemSmall])
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
        "Hesapların limitleri ve bugünkü maliyeti; Geç, Relay’de geçişi açar",
        "Your accounts' limits and cost today; Switch opens the switch in Relay"))
    .supportedFamilies([.systemMedium])
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
        "Hesapların limitleri, bugünün maliyeti, token’ları ve hesaplara dağılımı",
        "Your accounts' limits, and today's cost, tokens and split by account"))
    .supportedFamilies([.systemLarge])
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
        "Bugünkü Claude Code token’ları ve API karşılığı",
        "Today's Claude Code tokens and their API value"))
    .supportedFamilies([.systemSmall, .systemMedium])
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
        "Son yedi günün maliyeti, token’ları ve hesaplara dağılımı",
        "The last seven days' cost, tokens and split by account"))
    .supportedFamilies([.systemMedium])
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
