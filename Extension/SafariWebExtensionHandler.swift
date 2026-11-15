import SafariServices
import Photos
import UIKit
import ImageIO
import UniformTypeIdentifiers
import os.log

/// Receives messages from the extension's background script via
/// `browser.runtime.sendNativeMessage`. Downloads images natively (no CORS)
/// and saves them straight into the Photos library.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private let log = Logger(subsystem: "SafariScraper", category: "extension")

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message: Any?
        if #available(iOS 17.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        Task {
            let reply = await self.handle(message as? [String: Any] ?? [:])
            let response = NSExtensionItem()
            if #available(iOS 17.0, *) {
                response.userInfo = [SFExtensionMessageKey: reply]
            } else {
                response.userInfo = ["message": reply]
            }
            context.completeRequest(returningItems: [response], completionHandler: nil)
        }
    }

    private func handle(_ msg: [String: Any]) async -> [String: Any] {
        switch msg["action"] as? String {
        case "status":
            return ["photos": Self.photoStatus()]
        case "save":
            let items = msg["items"] as? [[String: Any]] ?? []
            return await save(items)
        default:
            return ["error": "unknown action"]
        }
    }

    static func photoStatus() -> String {
        switch PHPhotoLibrary.authorizationStatus(for: .addOnly) {
        case .authorized: return "authorized"
        case .limited: return "limited"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    private func save(_ items: [[String: Any]]) async -> [String: Any] {
        var saved = 0
        var failed: [[String: String]] = []

        await withTaskGroup(of: (String, String?).self) { group in
            for item in items {
                guard let urlString = item["url"] as? String, let url = URL(string: urlString) else { continue }
                let referer = item["referer"] as? String
                group.addTask {
                    do {
                        let data = try await Self.download(url, referer: referer)
                        try await Self.saveToPhotos(data)
                        return (urlString, nil)
                    } catch {
                        return (urlString, error.localizedDescription)
                    }
                }
            }
            for await (url, error) in group {
                if let error {
                    failed.append(["url": url, "error": error])
                } else {
                    saved += 1
                }
            }
        }
        log.info("saved \(saved) failed \(failed.count)")
        return ["saved": saved, "failed": failed]
    }

    private static let session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 20
        cfg.httpAdditionalHeaders = [
            "Accept": "image/avif,image/webp,image/heic,image/jpeg,image/png,image/*;q=0.8,*/*;q=0.5",
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        ]
        return URLSession(configuration: cfg)
    }()

    static func download(_ url: URL, referer: String?) async throws -> Data {
        if url.scheme == "data" {
            return try Data(contentsOf: url)
        }
        var req = URLRequest(url: url)
        if let referer { req.setValue(referer, forHTTPHeaderField: "Referer") }
        let (data, response) = try await session.data(for: req)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw SaveError("HTTP \(http.statusCode)")
        }
        return data
    }

    /// Photos accepts JPEG/PNG/HEIC/GIF/TIFF directly. Anything else (WebP, AVIF,
    /// BMP…) gets re-encoded so it doesn't get rejected.
    static func saveToPhotos(_ data: Data) async throws {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let typeId = CGImageSourceGetType(source) as String?,
              let type = UTType(typeId) else {
            throw SaveError("Not an image")
        }

        let native: [UTType] = [.jpeg, .png, .heic, .heif, .gif, .tiff]
        var payload = data
        if !native.contains(where: { type.conforms(to: $0) }) {
            guard let image = UIImage(data: data) else { throw SaveError("Unsupported format \(typeId)") }
            if let alpha = image.cgImage?.alphaInfo,
               [.first, .last, .premultipliedFirst, .premultipliedLast].contains(alpha),
               let png = image.pngData() {
                payload = png
            } else if let jpg = image.jpegData(compressionQuality: 0.95) {
                payload = jpg
            } else {
                throw SaveError("Couldn't convert \(typeId)")
            }
        }

        try await PHPhotoLibrary.shared().performChanges {
            let req = PHAssetCreationRequest.forAsset()
            req.addResource(with: .photo, data: payload, options: nil)
        }
    }
}

struct SaveError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
