// Relay's macOS widget: today's Claude Code tokens and their API value. Relay
// writes ~/Library/Application Support/Relay/widget/today.json with every
// string already formatted; this extension only reads and draws it. Built by
// scripts/build-native.mjs with -e _NSExtensionMain (without it chronod starts
// the extension and it exits: "Unrecognized extension type").
import SwiftUI
import WidgetKit

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
  }
  let version: Int
  let generatedAt: Double
  let date: String
  let zone: String
  let state: String
  let change: Double?
  let slots: [Double?]
  let yesterdayAverage: Double?
  let text: Texts
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
    snapshot.version == 1
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

private let staleAfter: TimeInterval = 30 * 60

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
}

struct TodayProvider: TimelineProvider {
  func placeholder(in context: Context) -> TodayEntry {
    TodayEntry(date: .now, snapshot: nil)
  }

  func getSnapshot(in context: Context, completion: @escaping (TodayEntry) -> Void) {
    completion(TodayEntry(date: .now, snapshot: readSnapshot()))
  }

  /**
   * Now, when the file turns stale, and the next midnight; Relay asks for a
   * reload when the numbers change, and the widget refreshes itself every 30
   * minutes in case it cannot. Both draw on the system's daily reload budget.
   */
  func getTimeline(in context: Context, completion: @escaping (Timeline<TodayEntry>) -> Void) {
    let now = Date.now
    let snapshot = readSnapshot()
    var dates = [now]
    if let snapshot {
      let stale = Date(timeIntervalSince1970: snapshot.generatedAt / 1000 + staleAfter)
      if stale > now { dates.append(stale) }
      if let midnight = nextMidnight(after: now, snapshot.zone) { dates.append(midnight) }
    }
    let entries = dates.sorted().map { TodayEntry(date: $0, snapshot: snapshot) }
    completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(30 * 60))))
  }
}

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

private let openRelay =
  Locale.preferredLanguages.first?.hasPrefix("tr") == true ? "Relay'i açın" : "Open Relay"

struct TodayView: View {
  @Environment(\.widgetFamily) var family
  let entry: TodayEntry

  var body: some View {
    Group {
      if let snapshot = entry.snapshot {
        if entry.newDay {
          message(snapshot.text.title, snapshot.text.empty)
        } else if snapshot.state != "data" {
          message(snapshot.text.title, snapshot.text.status)
        } else if family == .systemSmall {
          small(snapshot)
        } else {
          medium(snapshot)
        }
      } else {
        message("Relay", openRelay)
      }
    }
    .containerBackground(.background, for: .widget)
  }

  private func tone(_ snapshot: Snapshot) -> Color {
    guard let change = snapshot.change else { return .primary }
    return change >= 0 ? .green : .red
  }

  @ViewBuilder private func header(_ snapshot: Snapshot) -> some View {
    HStack(spacing: 4) {
      if let change = snapshot.change {
        Image(systemName: change >= 0 ? "arrowtriangle.up.fill" : "arrowtriangle.down.fill")
          .font(.system(size: 9))
          .foregroundStyle(tone(snapshot))
      }
      Text(snapshot.text.title).font(.headline)
    }
  }

  private func subtitle(_ snapshot: Snapshot) -> some View {
    Text(entry.stale ? snapshot.text.stale : snapshot.text.subtitle)
      .font(.caption2)
      .foregroundStyle(.secondary)
      .lineLimit(1)
  }

  private func message(_ title: String, _ line: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title).font(.headline)
      Text(line).font(.caption).foregroundStyle(.secondary)
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func small(_ snapshot: Snapshot) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      header(snapshot)
      subtitle(snapshot)
      Spacer(minLength: 2)
      Text(snapshot.text.cost)
        .font(.title2.bold()).monospacedDigit()
        .foregroundStyle(tone(snapshot))
        .minimumScaleFactor(0.6).lineLimit(1)
      HStack {
        Text(snapshot.text.total).font(.caption).monospacedDigit()
        Spacer()
        Text(snapshot.text.change).font(.caption.bold()).monospacedDigit()
          .foregroundStyle(tone(snapshot))
      }
      TodayLine(slots: snapshot.slots, average: snapshot.yesterdayAverage, color: tone(snapshot) == .primary ? .green : tone(snapshot))
        .frame(height: 28)
    }
  }

  private func medium(_ snapshot: Snapshot) -> some View {
    let values = [snapshot.text.input, snapshot.text.output, snapshot.text.cache]
    return HStack(alignment: .top, spacing: 14) {
      VStack(alignment: .leading, spacing: 2) {
        header(snapshot)
        subtitle(snapshot)
        Spacer(minLength: 4)
        ForEach(Array(zip(snapshot.text.rows, values)), id: \.0) { label, value in
          HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).monospacedDigit()
          }
          .font(.caption)
        }
        Spacer(minLength: 4)
        Text(snapshot.text.total)
          .font(.title.bold()).monospacedDigit()
          .minimumScaleFactor(0.6).lineLimit(1)
      }
      .frame(maxWidth: .infinity)
      VStack(alignment: .trailing, spacing: 2) {
        Text(snapshot.text.cost)
          .font(.title3.bold()).monospacedDigit()
          .foregroundStyle(tone(snapshot))
          .minimumScaleFactor(0.6).lineLimit(1)
        Text(snapshot.text.change)
          .font(.callout.bold()).monospacedDigit()
          .foregroundStyle(tone(snapshot))
        TodayLine(
          slots: snapshot.slots, average: snapshot.yesterdayAverage,
          color: tone(snapshot) == .primary ? .green : tone(snapshot), ticks: true
        )
        .padding(.top, 4)
      }
      .frame(maxWidth: .infinity)
    }
  }
}

struct RelayToday: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RelayToday", provider: TodayProvider()) { entry in
      TodayView(entry: entry)
    }
    .configurationDisplayName("Relay · Bugün")
    .description("Bugünkü Claude Code token’ları ve API karşılığı")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

@main
struct RelayWidgets: WidgetBundle {
  var body: some Widget { RelayToday() }
}
