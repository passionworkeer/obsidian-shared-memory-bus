import { buildHashFeatures, buildHashEmbedding } from "./bus/lsh-hash.js";
import fs from "node:fs";
const T = new Set();
const add = (s) => T.add(s);
const addAll = (arr) => arr.forEach(add);
addAll(["", " ", "   ", "\t", "\n", "\n\t  \n", " \n \t "]);
"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+[]{}|;:'\",.<>?/`~中文日字本語한".split("").forEach(add);
addAll("hello world test memory bus shared agent tool server client embed vector hash lsh fnv search index query rank score node python javascript retrieval bridge manifest schema version config prompt context token model claude obsidian vault tier session project archive event promote dream batch stream cache async sync spawn ipc stdio".split(" "));
addAll(["hello world","the quick brown fox jumps over the lazy dog","shared memory bus for multi agent ai setups","fnv-1a 32-bit hash for feature extraction","l2 normalized 384 dimension embedding vector","cross language equivalence test between js and python","portable local first shared memory bus","model context protocol server architecture","increment vector schema version and trigger full rebuild","the same algorithm is mirrored in retrieval lsh utils py","any change here must be synced to that file","alphanumeric word url token lowercased","cjk 2 plus character run with bigram and trigram","3 char sliding ngram over compact non whitespace text","fallback raw compact text when no other features fire","this is a test","another test string for embedding","hello world test embedding"]);
addAll(["中文","测试","共享","内存","总线","代理","工具","服务器","客户端","向量","哈希","检索","索引","查询","排序","分数","中文测试","共享内存","共享内存总线","多代理AI记忆共享","跨语言等价性测试","局部敏感哈希算法","特征提取与向量化","FNV-1a三十二位哈希","L2归一化三百八十四维向量","任何更改必须同步到该文件","字母数字单词URL标记小写化","中日韩两字符以上连续运行","三字符滑动n元语法","无其他特征时回退原始紧凑文本","增量版本号并触发全量重建","模型上下文协议服务器架构","可移植本地优先共享内存总线","中文测试向量生成","混合语言内容处理","人工智能记忆系统","知识图谱与语义搜索"]);
addAll(["hello 世界","test 测试","shared 共享 memory 记忆","JS端 buildHashFeatures 与 Py端 build_hash_features","VECTOR_SCHEMA_VERSION = 1 向量模式版本","FNV-1a32 哈希算法 hash algorithm","384维 L2-normalized vector 三百八十四维向量","node bus/lsh-hash.js 运行节点脚本","retrieval/lsh_utils.py 检索工具模块","cross-language 跨语言 equivalence 等价 test 测试","memory bus 记忆总线 agent 代理","中文 content with english words 英文单词","v1.2 版本 version 兼容性 compatibility","subprocess 子进程 bridge 桥接 node 节点","feature 特征 extraction 提取 algorithm 算法","embedding 嵌入 vector 向量 dimension 维度","normalize 归一化 whitespace 空白 trim 修剪","token 标记 chunk 块 bigram 二元 trigram 三元","slot 槽位 sign 符号 contribution 贡献","compact 紧凑 source 源码 lowercase 小写"]);
addAll(["https://example.com","https://example.com/path","https://example.com/path/to/resource","http://localhost:8080","http://localhost:3000/api/v1","https://github.com/user/repo","https://github.com/passionworkeer/obsidian-shared-memory-bus","https://nodejs.org/api/fs.html","https://docs.python.org/3/library/re.html","https://en.wikipedia.org/wiki/Fowler-Noll-Vo_hash_function","https://modelcontextprotocol.io/docs/concepts/architecture","ftp://files.example.com/file.txt","https://api.openai.com/v1/embeddings","https://registry.npmjs.org/package/eslint","https://pypi.org/project/hnswlib/","https://example.com:443/secure?query=1&sort=asc","https://example.com/path#anchor","https://user:pass@example.com/auth","wss://websocket.example.com/socket","https://doubao.com/docx/token123","https://doubao.com/wiki/node456","https://doubao.com/sheets/sheet789","https://doubao.com/base/bitable012","https://obsidian.md/","file:///C:/Users/test/vault/notes.md","file:///home/user/.ai-memory/inbox.jsonl","https://example.com/very/long/path/that/goes/on/and/on","https://example.com/api/v2/users/12345/posts/67890/comments","https://example.com/search?q=fnv1a+hash+lsh&lang=en"]);
addAll(["function foo() { return 42; }","const x = await import('node:url');","import { pathToFileURL } from 'node:url';","process.argv.slice(2)","console.log(JSON.stringify(result));","def build_hash_features(text):","import re; from typing import List","hash_value = (hash_value * 0x01000193) & 0xFFFFFFFF","vector = [0.0] * dimension","return [round(v / norm, 8) for v in vector]","if __name__ == '__main__': main()","subprocess.check_output(['node', 'bus/lsh-hash.js'])","npm run test:cross","node --test tests/cross-language/*.test.js","pytest tests/unit/py/ -v","git tag -a v3.2.0 -m 'server split + lsh sync'","const dimension = 384; const vector = new Array(dimension).fill(0);","for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); }","Math.imul(hash, 0x01000193) >>> 0","hash % dimension","((hash >>> 1) & 1) === 0 ? 1 : -1","vector[slot] += sign","norm = Math.sqrt(norm)","Number((vector[index] / norm).toFixed(8))"]);
addAll(["🎉🎊🎈","café résumé naïve","über Straße Grüße","日本語テスト","한국어 테스트","العربية اختبار","Ελληνικά δοκιμή","Русский тест","עברית בדיקה","emoji 🚀🔥💯✨ test","mixed 🎯 text 📝 here","tab\tseparated\tvalues","newline\nseparated\ntext","carriage\rreturn","punctuation!!! ??? ...","(parentheses) [brackets] {braces}","<html>tags</html>","/* comment */","// line comment","a=b+c-d*e/f","x>=y && z<=w","a!=b || c==d","100%","$100.00","#hashtag","@mention","path\\to\\windows\\file","path/to/unix/file","emoji_only_🦄🌈✨","mixed_中文_emoji_🎉"]);
addAll(["0","1","-1","42","100","3.14","-2.718","0.0","1e10","1.5e-3","0x1F","0xFF","0b1010","0o777","1234567890","999999999999","0.000001","1e-100","3.14159265358979","2.71828182845904","1,000,000","+100","-0","0123","0xdeadbeef","0xcafebabe","384","256","128","512","1024"]);
addAll(["bus/lsh-hash.js","retrieval/lsh_utils.py","tests/cross-language/lsh_equivalence.test.js","specs/lsh-fixture.json","docs/specs/lsh-protocol.md","retrieval/_lsh_subprocess.py","tech-debt-roadmap.md","package.json","CLAUDE.md","AGENTS.md","C:\\Users\\test\\.ai-memory\\inbox.jsonl","/home/user/.ai-memory/inbox.jsonl","~/.ai-memory/logs/start.log","./bus/lsh-hash.js","../retrieval/lsh_utils.py","shared-mcp/omni-memory-server.js","ops/adapters/schema-registry.json","tests/fixtures/promotion-judgments.jsonl","docs/architecture/SERVER-SPLIT.md","scripts/validate-layout.ps1"]);
addAll(["test@example.com","user.name@domain.org","admin@localhost","noreply@github.com","passionworkeer@users.noreply.github.com","a@b.co","x@y.io","dev@ai-memory.bus","contact@obsidian-shared-memory-bus.dev"]);
addAll(['{"key": "value"}','{"text": "hello", "expected": "abc123"}','[1, 2, 3]','{"nested": {"deep": {"value": 42}}}','{"version": 1, "features": ["w:hello"]}','<html><body>text</body></html>','<p class="test">paragraph</p>','<xml><node attr="val">data</node></xml>','# Markdown Heading','## Subheading','- list item','1. numbered item','**bold**','*italic*','[link](url)','| col1 | col2 |','---',"> quote"]);
const lb = "the quick brown fox jumps over the lazy dog ";
[lb, lb.repeat(3), lb.repeat(5), lb.repeat(10), lb.repeat(20),"a".repeat(100),"a".repeat(500),"a".repeat(1000),"ab".repeat(200),"abc".repeat(150),"中文测试".repeat(50),"共享内存总线".repeat(30),"hello world ".repeat(50),"test ".repeat(100),"x".repeat(401),"y".repeat(402),"z".repeat(403)].forEach(add);
addAll(["中文","中日韩","中日韩朝","中","中 文","a中b文c","中文a英文"]);
addAll(["ab","a-b","a_b","a.b","a/b","a:b","http://x","v1.2.3","node:18","pkg/sub/mod","file.txt","path/to/file.js","user@host","a1b2c3","192.168.1.1","3.14.159"]);
const fillers = ["test case","sample text","fixture entry","vector input","hash target","feature source","embedding text","lsh input","fnv seed","memory record","agent note","session log","project file","archive item","event marker","dream fragment","prompt text","context chunk","tool result","search query"];
const suffixes = [" alpha"," beta"," gamma"," delta"," epsilon"," v1"," v2"," v3"," #1"," #2"," #3"," (a)"," (b)"," (c)"," [x]"," [y]"," [z]"," 第一"," 第二"," 第三"," 测试"," 验证"," 数据"];
const prefixes = ["prefix_","data-","test.","sample/","case:","型","类","组","批","次"];
const all = [];
for (const f of fillers) for (const s of suffixes) all.push(f + s);
for (const p of prefixes) for (const f of fillers) all.push(p + f);
for (let i = 1; i <= 500; i++) { all.push(`generated-text-${i}`); all.push(`测试数据${i}`); all.push(`item_${i}_data`); }
for (const f of all) { if (T.size >= 1000) break; T.add(f); }
let pi = 0; while (T.size < 1000) { pi++; T.add(`__pad_${pi}__`); }
const final = Array.from(T).slice(0, 1000);
const fixtures = final.map((text) => {
  const features = buildHashFeatures(text);
  const emb = buildHashEmbedding(text, 384);
  let nz = 0; for (const v of emb) if (v !== 0) nz++;
  return { text, features, embedding_dim: 384, embedding_nonzero_count: nz };
});
fs.mkdirSync("specs", { recursive: true });
fs.writeFileSync("specs/lsh-fixture.json", JSON.stringify(fixtures, null, 2));
console.log(`Generated ${fixtures.length} fixtures`);
const e = fixtures.filter(f => f.features.length === 0).length;
const c = fixtures.filter(f => f.features.some(x => x.startsWith("c:"))).length;
const r = fixtures.filter(f => f.features.some(x => x.startsWith("raw:"))).length;
const g = fixtures.filter(f => f.features.some(x => x.startsWith("g3:"))).length;
console.log(`Stats: empty=${e} cjk=${c} raw=${r} g3=${g} avg=${(fixtures.reduce((s,f)=>s+f.features.length,0)/fixtures.length).toFixed(1)}`);
