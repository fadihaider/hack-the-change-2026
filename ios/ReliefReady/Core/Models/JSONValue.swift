import Foundation

// a plain json value: request bodies are built from these so the exact keys sent are explicit
nonisolated enum JSONValue: Codable, Sendable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    /// the keys of an object, or nil for any other value
    var objectKeys: Set<String>? {
        if case .object(let value) = self { return Set(value.keys) }
        return nil
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let value) = self { return value[key] }
        return nil
    }
}

nonisolated extension JSONValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral, ExpressibleByNilLiteral {
    init(stringLiteral value: String) { self = .string(value) }
    init(booleanLiteral value: Bool) { self = .bool(value) }
    init(integerLiteral value: Int) { self = .number(Double(value)) }
    init(dictionaryLiteral elements: (String, JSONValue)...) {
        self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
    }
    init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    init(nilLiteral: ()) { self = .null }
}

nonisolated extension JSONValue {
    /// a string, or json null for nil
    static func string(orNull value: String?) -> JSONValue {
        value.map(JSONValue.string) ?? .null
    }
}

/// a closed set of server words that still decodes when the server adds a new one
nonisolated protocol TolerantEnum: RawRepresentable, Codable, Sendable, Hashable, CaseIterable where RawValue == String {
    /// used for any word this build does not know
    static var fallback: Self { get }
}

nonisolated extension TolerantEnum {
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? Self.fallback
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}
