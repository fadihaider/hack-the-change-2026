import Foundation

// port of components/app/care/today-data.ts: which items show first, each item's status and reminder time

nonisolated enum DayItemStatus: Sendable, Hashable {
    case done, reminder, planned

    var label: String {
        switch self {
        case .done: "Done \u{2014} recorded by you"
        case .reminder: "Reminder now"
        case .planned: "Planned"
        }
    }
}

nonisolated struct DaySummary: Sendable, Hashable {
    var total: Int
    var done: Int
    /// earlier today and not marked done
    var earlier: Int
    /// the next item not marked done, on the app's today only
    var next: TimelineItem?
}

nonisolated enum TodayData {
    /// how many items the day shows before "Open full day"
    static let previewLimit = 4
    /// how many earlier, not-yet-done items stay in the preview next to what's coming up
    static let overdueInPreview = 2

    static func key(_ item: TimelineItem) -> String { "\(item.eventId)-\(item.startsAt)" }

    /// done only when the caregiver marked it
    static func status(_ item: TimelineItem) -> DayItemStatus {
        if let done = item.completedAt, !done.isEmpty { return .done }
        if item.highlight && item.remindMinutes > 0 { return .reminder }
        return .planned
    }

    /// when the reminder goes off; nil when no lead time is set
    static func reminderAt(_ item: TimelineItem) -> Date? {
        guard item.remindMinutes > 0, let start = AlbertaTime.parse(item.startsAt) else { return nil }
        return start.addingTimeInterval(-item.remindMinutes * 60)
    }

    static func startOf(_ item: TimelineItem) -> Double {
        AlbertaTime.parse(item.startsAt)?.timeIntervalSince1970 ?? .infinity
    }

    private static func isDone(_ item: TimelineItem) -> Bool {
        if let done = item.completedAt { return !done.isEmpty }
        return false
    }

    static func chronological(_ items: [TimelineItem]) -> [TimelineItem] {
        items.careStableSorted { a, b in
            let x = startOf(a)
            let y = startOf(b)
            if x != y { return x < y ? -1 : 1 }
            return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0
        }
    }

    /// the items worth seeing first, in time order. on the app's today: the latest couple of earlier items not marked
    /// done, then what's next, then the rest. on any other day (now nil): the first few in time order
    static func preview(_ items: [TimelineItem], now: Date?, limit: Int = previewLimit) -> (shown: [TimelineItem], hidden: Int) {
        let sorted = chronological(items)
        if sorted.count <= limit { return (sorted, 0) }
        guard let now else { return (Array(sorted.prefix(limit)), sorted.count - limit) }
        let nowValue = now.timeIntervalSince1970
        let indexed = Array(sorted.enumerated())
        let overdue = indexed.filter { !isDone($0.element) && startOf($0.element) < nowValue }.reversed().map(\.offset)
        let next = indexed.filter { !isDone($0.element) && startOf($0.element) >= nowValue }.map(\.offset)
        let done = indexed.filter { isDone($0.element) }.map(\.offset)
        let order = Array(overdue.prefix(overdueInPreview)) + next + Array(overdue.dropFirst(overdueInPreview)) + done
        let picked = Set(order.prefix(limit))
        return (indexed.filter { picked.contains($0.offset) }.map(\.element), sorted.count - picked.count)
    }

    static func summary(_ items: [TimelineItem], now: Date?) -> DaySummary {
        let sorted = chronological(items)
        let open = sorted.filter { !isDone($0) }
        let nowValue = now?.timeIntervalSince1970
        return DaySummary(
            total: sorted.count,
            done: sorted.count - open.count,
            earlier: nowValue.map { value in open.filter { startOf($0) < value }.count } ?? 0,
            next: nowValue.flatMap { value in open.first { startOf($0) >= value } }
        )
    }

    /// "4 things on this day. 1 marked done. Next: 8:00 a.m."
    static func overviewLine(_ summary: DaySummary) -> String {
        var parts = ["\(CareData.plural(summary.total, "thing", "things")) on this day."]
        if summary.done > 0 { parts.append("\(summary.done) marked done.") }
        if summary.earlier > 0 {
            parts.append("\(CareData.plural(summary.earlier, "earlier item isn\u{2019}t", "earlier items aren\u{2019}t")) marked done.")
        }
        if let next = summary.next {
            let at = AlbertaTime.format(next.startsAt, style: .time)
            parts.append("Next: \(at)\(at.hasSuffix(".") ? "" : ".")")
        }
        return parts.joined(separator: " ")
    }

    /// locked wording is shown whole; everything else shows its short title
    static func itemText(_ item: TimelineItem) -> String {
        guard item.factId != nil else { return item.title }
        let exact = item.fullText ?? item.title
        let locked = LockedWording.isLocked(category: item.category, text: exact)
            || LockedWording.isLocked(category: item.category, text: item.title)
        return locked ? exact : item.title
    }

    /// replaces one event's completion in a list of items
    static func withCompletion(_ items: [TimelineItem], eventId: String, completedAt: String?) -> [TimelineItem] {
        items.map { item in
            guard item.eventId == eventId else { return item }
            var copy = item
            copy.completedAt = completedAt
            return copy
        }
    }
}

nonisolated extension TimelineItem {
    /// one occurrence of an event on one day
    var careKey: String { TodayData.key(self) }
}
