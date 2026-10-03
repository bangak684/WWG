import AppKit
let image = NSImage(size: NSSize(width: 1024, height: 1024))
image.lockFocus()
NSColor(calibratedRed: 0.16, green: 0.34, blue: 0.28, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 50, y: 50, width: 924, height: 924), xRadius: 210, yRadius: 210).fill()
let attributes: [NSAttributedString.Key: Any] = [.font: NSFont(name: "Georgia", size: 730) ?? NSFont.systemFont(ofSize: 730), .foregroundColor: NSColor(calibratedRed: 0.94, green: 0.96, blue: 0.90, alpha: 1)]
("w" as NSString).draw(at: NSPoint(x: 205, y: 160), withAttributes: attributes)
NSColor(calibratedRed: 0.85, green: 0.65, blue: 0.40, alpha: 1).setFill()
NSBezierPath(ovalIn: NSRect(x: 764, y: 320, width: 68, height: 68)).fill()
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
