import SafariServices

/// CardScraper does everything in JavaScript; this handler only exists because
/// every Safari web extension needs a principal class.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let response = NSExtensionItem()
        if #available(iOS 17.0, *) {
            response.userInfo = [SFExtensionMessageKey: ["ok": true]]
        } else {
            response.userInfo = ["message": ["ok": true]]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
