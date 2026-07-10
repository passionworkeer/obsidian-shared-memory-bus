# Cross-Language LSH Fixture

`specs/lsh-fixture.json` (~482 KB) 是跨语言 LSH (Locality-Sensitive Hashing) 真值向量
基线,由 `_gen_fixture.js` 在仓库根目录生成。

**当前状态**: 无测试直接消费 (跨语言等价测试用 `tests/cross-language/shared-config-parity.test.js`
等内联断言,不再依赖此 fixture)。

**如需重新生成** (例如改 `bus/lsh-hash.js` 或 `retrieval/lsh_utils.py` 后):

```bash
node _gen_fixture.js   # 覆盖 specs/lsh-fixture.json
```

**为什么不进 git**:
1. 482 KB 是大文件,git 反复 add/rm 产生大 diff
2. 生成器 100% 确定性,克隆者随时能再生
3. 当前无消费方,占空间无收益

如果未来需要把 fixture 作为跨语言 CI 锚点,改为:
- `git add -f specs/lsh-fixture.json` 强加一次,作为基线快照
- CI 用 `node _gen_fixture.js --check` 验证一致性
