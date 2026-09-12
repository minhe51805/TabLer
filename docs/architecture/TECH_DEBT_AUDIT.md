# TableR — Đánh giá nợ kỹ thuật & kế hoạch khắc phục

> Trạng thái: **CHỜ DUYỆT**. Đây là ghi chú review + kế hoạch. Chưa sửa dòng code
> nào. Bạn đọc, tick vào phần muốn làm ở mục 6, rồi mình mới bắt tay.

## 0. Phạm vi & cách làm

- Rà soát toàn bộ flow lớn/nhỏ: query lifecycle, AI provider/agent, connection +
  SSH tunnel, sandbox/Safe Mode, driver 18 engine, error handling, config.
- Bằng chứng đều kèm `file:line` để bạn tự kiểm chứng, không phán chung chung.
- Mục tiêu của bạn (nguyên văn): tìm chỗ "đang **hard**, vá cho hiện tại chứ
  không ổn định lâu dài". Nên mình chấm điểm theo **"cái này sẽ gãy khi nào"**,
  không phải theo "code xấu hay đẹp".

## 1. Tóm tắt điều hành

Tin tốt trước: nền của app **không hề cẩu thả**. `DatabaseDriver` là trait
abstraction gọn; frontend dùng **named constant** khắp nơi (không rải magic
number bừa); `AppError` đã có sẵn; guard sandbox có test thật; `mongodb.rs` có
85 `unwrap` nhưng **tất cả nằm trong test** (0 ở path production).

Nợ thật sự **không phải "magic number"** mà là 4 loại sau, xếp theo mức nguy hiểm:

- **P1 — Sẽ gãy khi nâng cấp/mở rộng (im lặng, khó phát hiện):**
  giá trị trùng lặp hai đầu FE↔BE dễ lệch; nhận diện model bằng so chuỗi tên;
  header API pin theo ngày; tính năng SSH có lỗ hổng "lưu nhưng không dùng".
- **P2 — Bào mòn khả năng bảo trì:** timeout query hardcode không chỉnh được;
  logic phân loại SQL bị nhân đôi FE/BE; error type migrate dở dang; branching
  theo dialect rải rác; không có nơi cấu hình tập trung.
- **P3 — Nên dọn nhưng chưa gấp:** các hằng số tunable (pool size, cap sandbox,
  backoff, TTL) đang cứng, chưa cho chỉnh.

Khuyến nghị: làm **P1 trước** (rủi ro thật, effort nhỏ), P2 theo đợt, P3 gộp một
lần khi dựng "central config". Chi tiết ở mục 3.

---

## 2. Phát hiện chi tiết

Ký hiệu: **Mức** = P1/P2/P3 · **Effort** = S/M/L · mỗi mục có *Bằng chứng*,
*Vì sao là vá tạm*, *Đề xuất*.

### D1. Giá trị trùng lặp hai đầu FE↔BE dễ lệch — **P1 · S**

*Bằng chứng:*
- Frontend: `src/components/AISlidePanel/ai-conversation-state.ts:36-37`
  `BACKEND_MAX_HISTORY_MESSAGES = 12`, `BACKEND_MAX_HISTORY_CHARS = 24_000`.
- Backend: `src-tauri/src/database/ai_models.rs:200` `if self.history.len() > 12`
  và `:209` `if history_chars > 24_000` (kèm message "max 12 messages").

*Vì sao là vá tạm:* Hai literal ở hai ngôn ngữ, không có ràng buộc nào bắt chúng
bằng nhau. Ai sửa một bên (ví dụ nới lên 20 messages ở backend) mà quên bên kia
thì FE vẫn cắt ở 12, hoặc gửi 20 rồi backend **ném lỗi validation** mà FE không
lường trước. Đây đúng kiểu "chạy được hôm nay, lỗi âm thầm về sau".

*Đề xuất:* Chọn 1 nguồn sự thật. Cách nhẹ nhất: backend expose các hằng số này
qua 1 lệnh `get_ai_limits` (hoặc nhét vào payload config lúc khởi động) để FE
đọc runtime; hoặc tối thiểu thêm 1 **contract test** đọc cả hai và assert bằng
nhau, để CI chặn drift. Effort nhỏ.

### D2. Nhận diện năng lực model bằng so khớp chuỗi tên — **P1 · M**

*Bằng chứng:* `src-tauri/src/commands/ai/providers.rs:125-147`
- `model_supports_openai_thinking_switch`: chứa `deepseek-r1|qwq|qwen3|thinking`.
- `anthropic_model_supports_thinking`: chứa `claude-3-7|claude-sonnet-4|
  claude-opus-4|claude-haiku-4`.
- `gemini_model_supports_thinking`: chứa `2.5`.

*Vì sao là vá tạm:* Đây là allowlist theo tên model. Model đời mới (ví dụ họ
Claude/Gemini/Qwen phiên bản kế tiếp với cách đặt tên khác) sẽ **im lặng không
bật extended-thinking**, hoặc tệ hơn là bật nhầm rồi provider trả **HTTP 400**.
Cứ mỗi lần nhà cung cấp ra model mới là phải sửa tay chuỗi ở đây — không bền.

*Đề xuất:* Giữ allowlist làm "fast path", nhưng bọc lời gọi provider bằng
**fallback tự chữa**: nếu bật thinking mà provider trả 400 do tham số không hiểu,
tự tắt cờ và **retry một lần**, đồng thời cache "model X không hỗ trợ" trong
phiên. Như vậy model lạ vẫn chạy được thay vì hỏng.

### D3. Header `anthropic-version` pin cứng theo ngày — **P1 · S**

*Bằng chứng:* `src-tauri/src/commands/ai/execution.rs` (nhiều chỗ: 49, 187, 394,
540) đều `.header("anthropic-version", "2023-06-01")`.

*Vì sao là vá tạm:* Chuỗi ngày lặp lại 4+ nơi. Khi cần nâng version API (để dùng
tính năng mới hoặc khi Anthropic deprecate bản cũ) phải sửa rải rác, dễ sót.

*Đề xuất:* Tách thành 1 hằng số `ANTHROPIC_API_VERSION` một chỗ, mọi nơi tham
chiếu. (Gộp chung với mục "central config" ở D9.)

### D4. SSH tunnel: lưu key nhưng không dùng + type FE lạc hậu — **P1 · M**

*Bằng chứng:*
- Backend tunnel CÓ THẬT và đã wire: `src-tauri/src/ssh/ssh_tunnel.rs` +
  `src-tauri/src/database/manager.rs:121-135` (connect → forward_port → rewrite
  host về `127.0.0.1` + local_port).
- Nhưng `ssh_tunnel.rs:65-74`: nhánh PrivateKey **chỉ dùng `private_key_path`**;
  field `private_key` (nội dung key dán inline, `ssh_tunnel.rs:28`) **không bao
  giờ được đọc** trong `connect_tunnel`. Trong khi đó
  `storage/connection_storage.rs:40` **vẫn lưu** `ssh_private_key`.
- `ssh_tunnel.rs:71-73`: "PrivateKey auth without a file path is not fully
  supported yet".
- Type FE `src/types/ssh-config.ts:5-10` còn ghi "**NO Rust backend
  implementation yet**" (đã **lạc hậu** — backend tồn tại rồi), và dùng field
  `username/authMethod/privateKey/localPort/remoteHost/timeoutSeconds` **khác**
  với backend + form thật (`user/authType/privateKeyPath/passphrase`).

*Vì sao là vá tạm:* Người dùng dán private key inline vào form → app lưu vào
keyring → nhưng tunnel bỏ qua nó → **kết nối thất bại mà không rõ lý do**. Đây là
lỗ hổng "thành công giả": UI nhận, storage lưu, nhưng path thực thi làm ngơ. Cộng
thêm 1 file type FE mô tả sai sự thật → người sau đọc sẽ hiểu lầm.

*Đề xuất (chọn 1):*
- (a) **Hỗ trợ đủ:** đọc `private_key` inline trong `connect_tunnel` (ghi file
  tạm an toàn hoặc dùng `userauth_pubkey_memory`), bỏ nhánh "not supported".
- (b) **Thành thật với UI:** nếu chưa làm (a), disable ô "paste key inline" và
  chỉ cho chọn file path, kèm hint rõ ràng.
- Song song: viết lại `ssh-config.ts` cho khớp shape backend (bỏ @todo lạc hậu),
  hoặc xoá nếu không dùng.

### D5. Timeout query hardcode, không cho chỉnh — **P2 · M**

*Bằng chứng:* `src-tauri/src/commands/query.rs:23-24`
`READ_ONLY_QUERY_TIMEOUT = 180s`, `MUTATING_QUERY_TIMEOUT = 60s`. Phân loại ở
`timeout_for_statements` (xem `docs/architecture/QUERY_LIFECYCLE.md`).

*Vì sao là vá tạm:* 180s là con số hợp lý cho OLTP, nhưng với kho phân tích
(Snowflake/BigQuery/ClickHouse) một câu read nặng **chạy quá 180s là bình
thường** — người dùng không có cách nào nâng, câu query bị cắt oan. Ngược lại,
DB nhỏ có thể muốn siết chặt hơn. Một hằng số toàn cục không hợp với 18 engine
đặc tính rất khác nhau.

*Đề xuất:* Cho phép override: mặc định giữ 180/60, nhưng đọc từ settings
(per-connection tốt nhất, hoặc per-app). Không đổi hành vi mặc định, chỉ mở van.

### D6. Logic phân loại SQL bị nhân đôi FE/BE — **P2 · M**

*Bằng chứng:* Backend `src-tauri/src/utils/sql.rs` (`classify_sql`,
`detect_dangerous_capability`) là guard **thẩm quyền cuối**. Frontend lại có bộ
phân loại riêng: `src/utils/sql-safety.ts` (`classifySqlSafety`) dùng bởi
`src/utils/safe-mode-query-guard.ts` để quyết định hiện dialog xác nhận Safe Mode.

*Vì sao là vá tạm:* Hai bộ phân loại read/write/DDL sống song song. Backend là
nguồn enforcement thật (tốt), nhưng nếu FE phân loại **lệch** với BE thì UX Safe
Mode sai: FE báo "an toàn, không cần xác nhận" trong khi BE lại chặn, hoặc FE bắt
xác nhận câu mà BE cho qua. Càng thêm dialect/keyword thì hai bên càng dễ trôi.

*Đề xuất:* Không cần hợp nhất triệt để (FE cần phản hồi tức thì, không thể mỗi
phím gọi backend). Nhưng nên có **test đối chiếu**: một bộ fixture SQL dùng chung,
chạy qua cả `classifySqlSafety` (FE) và `classify_sql` (BE), assert cùng verdict
ở các ca chính. CI sẽ bắt drift.

### D7. Error type migrate dở dang — **P2 · M**

*Bằng chứng:* `src-tauri/src/error.rs` có `AppError` với các variant
(`Connection/Query/Validation/Storage/RateLimited/Other`). Nhưng còn ~159 chỗ
vẫn `.map_err(|e| e.to_string())` hoặc `.to_string().into()` → gom hết về
`AppError::Other(String)`, **mất phân loại**.

*Vì sao là vá tạm:* Đã bỏ công dựng error type có cấu trúc nhưng phần lớn command
vẫn "dẹt" nó thành chuỗi. Frontend không thể phân nhánh theo loại lỗi (ví dụ
retry riêng cho `RateLimited`, hiện UI khác cho `Connection` vs `Validation`).
Đây là đầu tư nửa vời — chi phí bỏ ra rồi mà chưa gặt được lợi.

*Vì sao chưa gấp:* Không gây bug ngay, chỉ chặn khả năng xử lý lỗi tinh tế về
sau. Nên làm dần theo module, không cần một cú refactor lớn.

*Đề xuất:* Migrate theo từng flow (bắt đầu từ AI + connection — nơi lỗi cần phân
nhánh nhất), map lỗi driver về đúng variant thay vì `Other`.

### D8. Branching theo dialect rải rác — **P2 · L**

*Bằng chứng:* ~399 điểm `match ... database_type` / `DatabaseType::` trong
`src-tauri/src`. Có nơi đã gom tốt (`database/capabilities.rs`,
`query_model_for`, trait `DatabaseDriver`), nhưng branching vẫn **rò rỉ** sang
nhiều command: `connection.rs`, `export_support.rs`, `maintenance.rs`,
`operations.rs`, `schema_diff.rs`, `search.rs`, `users_roles.rs`.

*Vì sao là vá tạm:* Muốn thêm engine #19 phải sửa vá nhiều file (shotgun
surgery), dễ sót một nhánh → engine mới "thiếu tính năng" một cách âm thầm.

*Vì sao chưa gấp:* Một phần branching là **bản chất** (18 engine khác nhau thật).
Rủi ro chỉ tăng khi thêm engine. Không cần đập đi làm lại.

*Đề xuất:* Không "trừu tượng hoá cho vui". Chỉ gom những nhánh **lặp cùng một
quyết định** vào `capabilities.rs` (ví dụ: "engine này có schema không",
"quote identifier kiểu gì"). Làm khi có dịp đụng tới, không thành 1 phase riêng.

### D9. Không có nơi cấu hình tập trung — **P3 · M**

*Bằng chứng:* Rust không có module `config`/`constants` (hằng số nằm rải trong
~30 file). Frontend chỉ có `src/constants/version.ts`; các tunable như
`useConnectionHealthMonitor.ts` (30s/5min/5s), `schema-cache-store.ts` (TTL
5min), agent budget (`ai-agent-cost.ts` 120_000), `MAX_AGENT_STEPS = 10`
(`use-ai-slide-panel.ts:123`)… mỗi thứ một nơi.

*Vì sao là vá tạm:* Bản thân việc đặt named constant là **tốt** (không phải magic
number). Vấn đề là **không audit/không tinh chỉnh tập trung được**, và một số giá
trị lẽ ra nên cho người dùng chỉnh (timeout ở D5, agent budget) thì đang cứng.

*Đề xuất:* Gom dần: một `src-tauri/src/config.rs` cho hằng số backend (kéo luôn
D3, D5 vào), một `src/config/*` cho tunable FE. Không đổi giá trị, chỉ tập trung
để dễ soi và mở cửa cho settings sau này.

### D10. Các cap/tham số vận hành đang cứng — **P3 · S**

*Bằng chứng (đều là named constant, chỉ là chưa tunable):*
- Pool `max_connections = 8` (Postgres/MySQL, xem QUERY_LIFECYCLE.md).
- Sandbox cap AI: `SANDBOX_AGENT_MAX_ROWS = 5_000`,
  `SANDBOX_AGENT_MAX_RESULT_BYTES = 8MB` (`query.rs:30-31`).
- Retry backoff `800 * (attempt+1)` ms (`ai/execution.rs:414`).
- Token mặc định: Inline `256`, Panel `4096`, thinking `2048`
  (`ai/providers.rs:107-119`).

*Vì sao chưa gấp:* Giá trị đang hợp lý, chưa gây lỗi. Chỉ là khi cần tinh chỉnh
(máy mạnh muốn pool to hơn, agent cần cap lớn hơn) thì phải build lại.

*Đề xuất:* Kéo vào central config ở D9 khi làm; chưa cần động nếu chưa có nhu cầu.

---

## 3. Kế hoạch khắc phục theo đợt (đề xuất thứ tự)

Nguyên tắc: **rủi ro cao + effort thấp làm trước**; mỗi đợt độc lập, có test,
review được riêng; không đổi hành vi mặc định trừ khi bạn đồng ý.

### Đợt 1 — Chặn "lỗi âm thầm" (P1, effort nhỏ) — *đề xuất làm đầu tiên*
- D1: một nguồn sự thật cho history limit (expose từ BE hoặc contract test).
- D3: gom `ANTHROPIC_API_VERSION` về một hằng số.
- D4: vá lỗ hổng SSH "lưu key inline nhưng không dùng" (chọn phương án a hoặc b)
  + sửa/đồng bộ `ssh-config.ts`.
- *Kiểm chứng:* `cargo test` + `vitest` + thử tay 1 kết nối SSH bằng password.

### Đợt 2 — Chống lệch & tự chữa (P1/P2)
- D2: fallback tự tắt-thinking-khi-400 + cache theo phiên.
- D6: bộ fixture SQL đối chiếu FE↔BE cho classifier.
- *Kiểm chứng:* test giả lập 400 từ provider; fixture chạy hai phía cùng verdict.

### Đợt 3 — Cho phép cấu hình (P2/P3)
- D5: timeout query đọc từ settings (giữ default 180/60).
- D9 + D10 + D3: dựng `config.rs` (BE) và `src/config` (FE), kéo hằng số về.
- *Kiểm chứng:* mặc định không đổi; thêm test cho path đọc override.

### Đợt 4 — Dọn dần, không gấp (P2)
- D7: migrate `AppError` theo từng flow (AI, connection trước).
- D8: gom nhánh dialect lặp vào `capabilities.rs` khi có dịp đụng tới.
- *Kiểm chứng:* full suite xanh sau mỗi module.

Mỗi đợt: mình sẽ lập todo chi tiết, đọc chính xác đoạn cần sửa, sửa nhỏ, chạy
test nền, rồi báo kết quả kèm số liệu (giống các lần trước).

---

## 4. Cố ý KHÔNG làm (tránh over-engineer)

- **Không** dựng framework config động/hot-reload — quá mức cho app desktop.
- **Không** ép hợp nhất classifier FE↔BE thành một (FE cần phản hồi tức thì);
  chỉ cần test đối chiếu.
- **Không** viết lại lớp driver theo plugin registry — trait hiện tại đủ tốt.
- **Không** đổi giá trị mặc định (timeout, cap, budget) trong lúc refactor; chỉ
  "mở van" cho chỉnh. Đổi default là quyết định sản phẩm, cần bạn duyệt riêng.
- **Không** đụng 85 `unwrap` trong test của `mongodb.rs` — chúng an toàn.

---

## 5. Những chỗ đang LÀM TỐT (không cần sửa)

- `DatabaseDriver` trait + default method: thêm engine không phải sửa nơi gọi.
- Frontend dùng named constant có chú thích lý do (ví dụ vì sao Panel = 4096).
- Guard sandbox có test thật; audit log `operation=sandbox.denied` tách riêng.
- Cancel query có `Drop` guard dọn registry kể cả khi panic/timeout.

---

## 6. Bảng duyệt (bạn tick vào đây)

| Mã  | Vấn đề | Mức | Effort | Duyệt làm? |
| --- | --- | --- | --- | --- |
| D1  | History limit lệch FE↔BE | P1 | S | ☐ |
| D2  | Model-thinking allowlist theo tên | P1 | M | ☐ |
| D3  | `anthropic-version` pin theo ngày | P1 | S | ☐ |
| D4  | SSH lưu key inline nhưng không dùng + type lạc hậu | P1 | M | ☐ |
| D5  | Timeout query hardcode | P2 | M | ☐ |
| D6  | Classifier SQL nhân đôi FE/BE | P2 | M | ☐ |
| D7  | `AppError` migrate dở dang | P2 | M | ☐ |
| D8  | Branching dialect rải rác | P2 | L | ☐ |
| D9  | Không có central config | P3 | M | ☐ |
| D10 | Cap/tham số vận hành cứng | P3 | S | ☐ |

Bạn có thể trả lời gọn: "làm Đợt 1", hoặc "chỉ D1 + D4", hoặc chọn từng mã. Mình
chỉ bắt đầu code sau khi bạn chốt.

---

## 7. Trạng thái thực thi (đã duyệt "full P1–P3")

Kiểm chứng cuối: `cargo test --lib` **300 passed / 0 failed** · `vitest run`
**915 passed (120 files)** · `tsc --noEmit` **0** · `eslint` (file đã đổi) **0**.

| Mã | Trạng thái | Việc đã làm |
| --- | --- | --- |
| D1 | ✅ Xong | Hằng số AI-limit gom về `config.rs` + mirror `src/config/ai-limits.ts`; `ai_models.rs` đọc từ config; **contract test FE↔BE** (`tests/config/backend-contract.test.ts`, 5 ca) chặn drift. |
| D2 | ✅ Xong | `providers.rs`: cache model + `is_thinking_param_rejection`; 3 body-builder gate thêm `!model_thinking_unsupported`; `execution.rs`: tự tắt-thinking + retry 1 lần khi 400. 4 test mới. |
| D3 | ✅ Xong | `ANTHROPIC_API_VERSION` một hằng số, wire 4 site trong `execution.rs`. |
| D4 | ✅ Xong | `ssh_tunnel.rs` hỗ trợ private key inline (`userauth_pubkey_memory` trên Unix, temp-file có RAII-cleanup trên Windows); thêm ô paste key vào form; **xoá** `ssh-config.ts` (dead + lạc hậu). |
| D5 | ✅ Xong | Timeout đọc qua `config::read_only_query_timeout()/mutating_query_timeout()`; env override `TABLER_READ_TIMEOUT_SECS`/`TABLER_MUTATING_TIMEOUT_SECS`; **default 180/60 không đổi**. 3 test. |
| D6 | ✅ Xong | Fixture chung `tests/fixtures/sql-classification-contract.json`; test hai phía: FE (`isMutatingStatement`+`isSessionSwitchStatement`, 14 ca) và BE (`classify_sql_with_dialect`, 14 ca). |
| D9 | ✅ Xong | `src-tauri/src/config.rs` (BE) + `src/config/` (FE) làm nơi cấu hình tập trung. |
| D10 | ✅ Xong | Pool size, sandbox cap, backoff, token budget đã kéo về `config.rs` (giá trị không đổi). |
| D7 | ✅ Slice an toàn | `ask_ai`/`ask_ai_stream` → `Result<_, AppError>` (passthrough `Other`, **giữ nguyên chuỗi lỗi** nên FE `normalizeAIRequestError` không đổi). Xem "Chặn kỹ thuật" bên dưới. |
| D8 | ✅ Slice an toàn | Thêm `is_sqlite_family()` (capabilities.rs) + dùng ở export preamble/postamble; test bao 18 engine. Các match-arm còn lại chuyển dần. |

### Hai phát hiện mới trong lúc làm (cần bạn quyết)

1. **D7 — chặn kỹ thuật thật:** `AppError::Display` **tự thêm tiền tố** ("Query
   error: …", "Rate limited: …"), trong khi FE **phân loại lỗi AI theo nội dung
   chuỗi** (`normalizeAIRequestError` → code timeout/provider/cancelled). Vì vậy
   "phân loại lỗi theo variant" (phần mang lại lợi ích thật) sẽ **đổi chuỗi lỗi
   người dùng thấy** và có thể phá phân loại FE. Mình đã migrate flow AI sang
   `AppError` **giữ nguyên chuỗi** (nền tảng), và **để lại việc phân loại variant
   làm bước sau** — nó cần: (a) thêm trường "kind" máy-đọc-được vào serialize của
   `AppError` (không đổi thông điệp), rồi (b) cập nhật `normalizeAIRequestError`
   dùng "kind" thay vì so chuỗi. Đây là quyết định thiết kế nhỏ, cần bạn duyệt.

2. **D8 — hai bảng nhãn engine lệch nhau:** `connection_support.rs`
   (`connection_engine_label`) và `capabilities.rs` (`driver_capabilities().label`)
   **khác nhau ở 3 engine**: Redshift ("Redshift" vs "Amazon Redshift"),
   Cassandra ("Cassandra" vs "Apache Cassandra"), BigQuery ("BigQuery" vs "Google
   BigQuery"). Gộp về một nguồn sẽ **đổi nhãn hiển thị** 3 engine này → mình
   **không gộp** (tránh đổi UI ngầm). Bạn muốn nhãn nào là chuẩn thì mình gộp theo.

