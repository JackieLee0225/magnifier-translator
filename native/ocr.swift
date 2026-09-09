// native/ocr.swift
//
// Apple Vision 文字识别（OCR）原生二进制
// --------------------------------------------------------------
// 编译：npm run build:ocr  （等价于下面的 swiftc 命令）
//   swiftc -O -framework Vision -framework AppKit native/ocr.swift -o build/vision-ocr
//
// 用法：build/vision-ocr <图片路径>
//   读取 PNG/JPG，跑 VNRecognizeTextRequest(accurate)，
//   把识别结果以 JSON 打印到 stdout，错误信息打印到 stderr。
//
// 为什么走原生二进制而不是 Node 库：
//   - Vision 是 macOS 系统框架，离线、免费、中文准确率高；
//   - Swift 编译成一个 ~300KB 的 Mach-O，electron-builder 直接打进 .dmg，
//     不依赖 Python/网络，也不增加体积；
//   - 通过 child_process 调用，ocr.js 里 Tesseract 作为降级兜底。
//
// 输出 JSON 结构：
// {
//   "text": "整段文字（按阅读顺序拼接）",
//   "confidence": 0.95,          // 所有文本块置信度的均值，0~1
//   "engine": "vision",
//   "blocks": [                  // 每一行/词
//     { "text": "...", "confidence": 0.9,
//       "bbox": { "x": 12.3, "y": 45.6, "width": 200.1, "height": 30.0 } }  // 像素坐标，原点在左上
//   ]
// }

import Foundation
import Vision
import AppKit

// ---- 与输出 JSON 对应的结构 ----
struct BBox: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct Block: Codable {
    let text: String
    let confidence: Double
    let bbox: BBox
}

struct OCRResult: Codable {
    let text: String
    let confidence: Double
    let engine: String
    let blocks: [Block]
}

// ---- 读取图片为 CGImage（优先 CGImageSource，兜底 NSImage）----
func loadCGImage(_ path: String) -> CGImage? {
    let url = URL(fileURLWithPath: path)
    if let src = CGImageSourceCreateWithURL(url as CFURL, nil),
       let img = CGImageSourceCreateImageAtIndex(src, 0, nil) {
        return img
    }
    // 兜底：有些格式 NSImage 能读但 CGImageSource 不行
    if let ns = NSImage(contentsOfFile: path),
       let img = ns.cgImage(forProposedRect: nil, context: nil, hints: nil) {
        return img
    }
    return nil
}

// ---- 主流程 ----
func main() {
    guard CommandLine.arguments.count > 1 else {
        fputs("usage: vision-ocr <image-path>\n", stderr)
        exit(2)
    }
    let path = CommandLine.arguments[1]

    guard let cgImage = loadCGImage(path) else {
        fputs("error: cannot load image at \(path)\n", stderr)
        exit(3)
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    // 中文简体 / 繁体 / 英文；系统自带，无需下载模型
    request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        fputs("error: vision perform failed: \(error)\n", stderr)
        exit(4)
    }

    guard let observations = request.results, !observations.isEmpty else {
        // 没有识别到任何文字，输出空结果（不算错误）
        let empty = OCRResult(text: "", confidence: 0, engine: "vision", blocks: [])
        writeJSON(empty)
        exit(0)
    }

    let imgW = Double(cgImage.width)
    let imgH = Double(cgImage.height)

    // 按阅读顺序排序：先按「顶部 y」从上到下，再按「左 x」从左到右。
    // （针对横向排版的屏幕文字；竖排古籍不在本工具场景内）
    let sorted = observations.sorted { (a, b) -> Bool in
        let ay = 1 - a.boundingBox.origin.y - a.boundingBox.height
        let by = 1 - b.boundingBox.origin.y - b.boundingBox.height
        if abs(ay - by) > 0.02 { return ay < by }
        return a.boundingBox.origin.x < b.boundingBox.origin.x
    }

    var blocks: [Block] = []
    var lines: [String] = []
    var confSum = 0.0
    var confCount = 0

    for obs in sorted {
        guard let candidate = obs.topCandidates(1).first else { continue }
        let txt = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !txt.isEmpty else { continue }

        let conf = candidate.confidence        // 0~1
        let b = obs.boundingBox                // 归一化，原点在左下

        // 换算成左上原点、像素单位，方便后续（可选）高亮描边
        let bbox = BBox(
            x: b.origin.x * imgW,
            y: (1 - b.origin.y - b.height) * imgH,
            width: b.width * imgW,
            height: b.height * imgH
        )

        blocks.append(Block(text: txt, confidence: Double(conf), bbox: bbox))
        lines.append(txt)
        confSum += Double(conf)
        confCount += 1
    }

    let avgConf = confCount > 0 ? confSum / Double(confCount) : 0.0
    let result = OCRResult(
        text: lines.joined(separator: "\n"),
        confidence: avgConf,
        engine: "vision",
        blocks: blocks
    )
    writeJSON(result)
}

func writeJSON(_ result: OCRResult) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
    do {
        let data = try encoder.encode(result)
        FileHandle.standardOutput.write(data)
        // 结尾换行，方便管道消费
        if let nl = "\n".data(using: .utf8) { FileHandle.standardOutput.write(nl) }
    } catch {
        fputs("error: json encode failed: \(error)\n", stderr)
        exit(5)
    }
}

main()
