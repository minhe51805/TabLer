import { Search, X, Plug, Database } from "lucide-react";
import type { CSSProperties } from "react";
import { DatabaseBrandIcon } from "../DatabaseBrandIcon";
import type { AppLanguage } from "../../../i18n";
import {
  LOCAL_BOOTSTRAP_PLANNED,
  LOCAL_BOOTSTRAP_READY,
  type DbEntry,
} from "../engine-registry";

interface PickerSection {
  key: string;
  title: string;
  caption: string;
  items: DbEntry[];
}

interface PickerStrings {
  pickerKicker: string;
  pickerLocalTitle: string;
  pickerTitle: string;
  pickerLocalSubtitle: string;
  pickerSubtitle: string;
  flowLabel: string;
  remoteSaved: string;
  localDb: string;
  ready: string;
  roadmap: string;
  shown: string;
  localReady: string;
  localSoon: string;
  searchPlaceholder: string;
  emptySearch: string;
  readyNow: string;
  readyNowCaption: string;
  roadmapCaption: string;
  localReadyCaption: string;
  localRoadmap: string;
  localRoadmapCaption: string;
  selection: string;
  workflow: string;
  mode: string;
  availability: string;
  engineType: string;
  connectionSetup: string;
  localBootstrap: string;
  fileDatabase: string;
  serverDatabase: string;
  createFreshLocalInstead: string;
  prismaNote: string;
  pickLocalEngine: string;
  pickDatabaseType: string;
  selectionHint: string;
  previewOnly: string;
  doubleClickContinue: string;
  cancel: string;
  continue: string;
  close: string;
  back: string;
}

export interface ConnectionPickerStepProps {
  language: AppLanguage;
  bootstrapMode: boolean;
  editConnection?: boolean;
  selectedDb: DbEntry | null;
  pickerSearch: string;
  pickerSections: PickerSection[];
  filteredDbs: DbEntry[];
  supportedCount: number;
  roadmapCount: number;
  localRoadmapCount: number;
  strings: PickerStrings;
  onSearchChange: (value: string) => void;
  onSelectDb: (db: DbEntry) => void;
  onDoubleClickDb: (db: DbEntry) => void;
  onSwitchIntent: (intent: "connect" | "bootstrap") => void;
  onClose: () => void;
  onContinue: () => void;
  onBack?: () => void;
}

function getPickerMetaLabel(db: DbEntry, language: AppLanguage) {
  if (db.isFile) return language === "vi" ? "Quy trình dựa trên tệp" : "File-based workflow";
  if (db.defaultPort) return language === "vi" ? `Cổng mặc định ${db.defaultPort}` : `Default port ${db.defaultPort}`;
  return language === "vi" ? "Quy trình cloud-native" : "Cloud-native flow";
}

function getPickerDescription(db: DbEntry, bootstrapMode: boolean, language: AppLanguage) {
  if (bootstrapMode) {
    if (LOCAL_BOOTSTRAP_READY.has(db.key)) {
      return db.key === "sqlite"
        ? language === "vi"
          ? "Tạo một cơ sở dữ liệu tệp cục bộ mới và mở ngay."
          : "Create a fresh local file database and open it instantly."
        : language === "vi"
          ? "Khởi tạo một workspace cục bộ rồi kết nối thẳng vào đó."
          : "Bootstrap a local workspace, then connect right into it.";
    }

    if (LOCAL_BOOTSTRAP_PLANNED.has(db.key)) {
      return language === "vi"
        ? "Đã hiển thị trong lộ trình, nhưng luồng bootstrap local chưa được nối xong."
        : "Visible in the roadmap, but the local bootstrap flow is not wired yet.";
    }

    if (db.supported) {
      return language === "vi"
        ? "Bạn có thể kết nối tới engine này ngay hôm nay, nhưng bootstrap local vẫn chưa sẵn sàng."
        : "You can connect to this engine today, but local bootstrap is still pending.";
    }

    return language === "vi" ? "Chưa khả dụng trong bản build này." : "Not available in this build yet.";
  }

  return db.supported
    ? language === "vi"
      ? "Sẵn sàng cấu hình host, thông tin đăng nhập và chi tiết cơ sở dữ liệu."
      : "Ready to configure with host, credentials, and database details."
    : language === "vi"
      ? "Đã hiển thị trong lộ trình sản phẩm và chưa khả dụng trong bản build này."
      : "Shown in the product roadmap and not available in this build yet.";
}

function getPickerCapabilities(db: DbEntry, bootstrapMode: boolean, language: AppLanguage) {
  const capabilities: string[] = [];

  if (bootstrapMode) {
    if (LOCAL_BOOTSTRAP_READY.has(db.key)) {
      capabilities.push(language === "vi" ? "Bootstrap local" : "Local bootstrap");
    } else {
      capabilities.push(language === "vi" ? "Lộ trình" : "Roadmap");
    }

    if (db.supported && !LOCAL_BOOTSTRAP_READY.has(db.key)) {
      capabilities.push(language === "vi" ? "Lộ trình local" : "Local roadmap");
    }
  } else {
    capabilities.push(
      db.supported
        ? language === "vi"
          ? "Sẵn sàng"
          : "Ready now"
        : language === "vi"
          ? "Lộ trình"
          : "Roadmap",
    );
  }

  if (db.isFile) {
    capabilities.push(language === "vi" ? "Theo tệp" : "File based");
  } else if (db.defaultPort) {
    capabilities.push(language === "vi" ? `Cổng ${db.defaultPort}` : `Port ${db.defaultPort}`);
  }

  if (db.supported) {
    capabilities.push(language === "vi" ? "Workspace đã lưu" : "Saved workspace");
  }

  return capabilities.slice(0, 3);
}

function getPickerHighlights(db: DbEntry, bootstrapMode: boolean, language: AppLanguage) {
  if (bootstrapMode) {
    if (db.key === "sqlite") {
      return language === "vi"
        ? [
            "Tạo một cơ sở dữ liệu tệp cục bộ mới và mở ngay lập tức.",
            "Rất hợp cho prototype, demo, và làm việc offline.",
            "Có thể áp dụng SQL khởi tạo tùy chọn trong lúc bootstrap.",
          ]
        : [
            "Create a fresh local file database and open it immediately.",
            "Great for prototyping, demos, and offline work.",
            "Optional starter SQL can be applied during bootstrap.",
          ];
    }

    if (LOCAL_BOOTSTRAP_READY.has(db.key)) {
      return language === "vi"
        ? [
            "Khởi tạo một cơ sở dữ liệu local rồi tự động kết nối vào workspace.",
            "Có thể áp dụng preset schema khởi đầu và import SQL ngay khi tạo.",
            "Phù hợp nhất khi bạn muốn một cơ sở dữ liệu local có server thật.",
          ]
        : [
            "Bootstraps a local database, then connects into the workspace automatically.",
            "Starter schema presets and SQL import can be applied on creation.",
            "Best fit when you want a real server-backed local dev database.",
          ];
    }

    if (db.supported) {
      return language === "vi"
        ? [
            "Kết nối thông thường đã được hỗ trợ trong bản build này.",
            "Bootstrap local chưa được nối xong, nên hãy dùng luồng kết nối tiêu chuẩn.",
            "Engine vẫn hiển thị ở đây để bạn có thể lên kế hoạch mà không mất ngữ cảnh.",
          ]
        : [
            "Normal connections are supported in this build.",
            "Local bootstrap is not wired yet, so use the standard connect flow.",
            "Visible here so you can plan your target engine without losing context.",
          ];
    }

    return language === "vi"
      ? [
          "Engine này đã có trong lộ trình nhưng chưa khả dụng trong bản build hiện tại.",
          "Hãy dùng nó như một mốc tham chiếu cho workflow local ở các bản sau.",
          "Chọn một engine local-ready nếu bạn muốn bootstrap ngay bây giờ.",
        ]
      : [
          "This engine is visible in the roadmap but not available in this build yet.",
          "Use it as a planning reference for future local workflows.",
          "Pick a local-ready engine if you want to bootstrap right now.",
        ];
  }

  if (db.isFile) {
    return language === "vi"
      ? [
          "Không cần host server, chỉ cần đường dẫn tới tệp cơ sở dữ liệu.",
          "Đây là cách nhanh nhất để dựng một workspace local với thiết lập tối thiểu.",
          "Rất hợp cho dữ liệu nhẹ, prototype, và kiểm thử offline.",
        ]
      : [
          "No server host is required, just a database file path.",
          "Fastest way to spin up a local workspace with minimal setup.",
          "Ideal for lightweight app data, prototypes, and offline testing.",
        ];
  }

  if (db.supported) {
    return language === "vi"
      ? [
          "Cấu hình host, thông tin đăng nhập, và chi tiết cơ sở dữ liệu tùy chọn.",
          "Kết nối đã lưu, query tabs, và object explorer đều khả dụng.",
          "Đây là lựa chọn mặc định tốt nếu engine này đã nằm trong stack của bạn.",
        ]
      : [
          "Configure host, credentials, and optional database details.",
          "Saved connections, query tabs, and object explorer are available.",
          "Good default choice if this is already part of your stack today.",
        ];
  }

  return language === "vi"
    ? [
        "Engine này đang được hiển thị như một phần của lộ trình sản phẩm.",
        "Nó chưa thể cấu hình trong bản build hiện tại.",
        "Hãy chọn một engine đã sẵn sàng nếu bạn muốn kết nối ngay.",
      ]
    : [
        "This engine is shown as part of the product roadmap.",
        "It is not configurable in the current build yet.",
        "Choose a ready engine if you want to connect right away.",
      ];
}

function getPickerStatus(db: DbEntry, bootstrapMode: boolean, language: AppLanguage) {
  if (bootstrapMode) {
    if (LOCAL_BOOTSTRAP_READY.has(db.key)) {
      return { label: language === "vi" ? "Local sẵn sàng" : "Local Ready", tone: "supported", canContinue: true };
    }

    if (LOCAL_BOOTSTRAP_PLANNED.has(db.key)) {
      return { label: language === "vi" ? "Local sắp có" : "Local Soon", tone: "soon", canContinue: false };
    }

    if (db.supported) {
      return { label: language === "vi" ? "Sắp có" : "Soon", tone: "soon", canContinue: false };
    }

    return { label: language === "vi" ? "Sắp có" : "Soon", tone: "soon", canContinue: false };
  }

  return db.supported
    ? { label: language === "vi" ? "Sẵn sàng" : "Ready", tone: "supported", canContinue: true }
    : { label: language === "vi" ? "Sắp có" : "Soon", tone: "soon", canContinue: false };
}

export function ConnectionPickerStep({
  language,
  bootstrapMode,
  editConnection,
  selectedDb,
  pickerSearch,
  pickerSections,
  filteredDbs,
  supportedCount,
  roadmapCount,
  localRoadmapCount,
  strings,
  onSearchChange,
  onSelectDb,
  onDoubleClickDb,
  onSwitchIntent,
  onClose,
  onContinue,
}: ConnectionPickerStepProps) {
  const readyCount = bootstrapMode ? Array.from(LOCAL_BOOTSTRAP_READY).length : supportedCount;
  const roadmapTotal = bootstrapMode ? localRoadmapCount : roadmapCount;
  const selectedStatus = selectedDb ? getPickerStatus(selectedDb, bootstrapMode, language) : null;
  const selectedMeta = selectedDb ? getPickerMetaLabel(selectedDb, language) : "";
  const selectedDescription = selectedDb ? getPickerDescription(selectedDb, bootstrapMode, language) : "";
  const selectedCapabilities = selectedDb ? getPickerCapabilities(selectedDb, bootstrapMode, language) : [];
  const selectedHighlights = selectedDb ? getPickerHighlights(selectedDb, bootstrapMode, language) : [];

  return (
    <>
      <div className="connection-picker-head">
        <div className="connection-picker-copy">
          <span className="panel-kicker">{strings.pickerKicker}</span>
          <h2 className="connection-picker-title">
            {bootstrapMode ? strings.pickerLocalTitle : strings.pickerTitle}
          </h2>
          <p className="connection-picker-subtitle">
            {bootstrapMode ? strings.pickerLocalSubtitle : strings.pickerSubtitle}
          </p>
          {!editConnection && (
            <div className="connection-picker-mode-switch" role="group" aria-label={strings.flowLabel}>
              <button
                type="button"
                className={`connection-picker-mode-btn ${!bootstrapMode ? "active" : ""}`}
                onClick={() => onSwitchIntent("connect")}
                aria-pressed={!bootstrapMode}
              >
                <Plug className="w-3.5 h-3.5" />
                <span>{strings.remoteSaved}</span>
              </button>
              <button
                type="button"
                className={`connection-picker-mode-btn ${bootstrapMode ? "active" : ""}`}
                onClick={() => onSwitchIntent("bootstrap")}
                aria-pressed={bootstrapMode}
              >
                <Database className="w-3.5 h-3.5" />
                <span>{strings.localDb}</span>
              </button>
            </div>
          )}
          <div className="connection-picker-stats">
            <span className="connection-picker-stat accent">
              <strong>{readyCount}</strong>
              <span>{bootstrapMode ? strings.localReady : strings.ready}</span>
            </span>
            <span className="connection-picker-stat">
              <strong>{roadmapTotal}</strong>
              <span>{bootstrapMode ? strings.localRoadmap : strings.roadmap}</span>
            </span>
            <span className="connection-picker-stat">
              <strong>{filteredDbs.length}</strong>
              <span>{strings.shown}</span>
            </span>
          </div>
        </div>

        <div className="connection-picker-head-side">
          <div className={`connection-picker-head-glance ${selectedDb ? "has-selection" : ""}`}>
            <span className="connection-picker-footer-label">{strings.selection}</span>

            {selectedDb && selectedStatus ? (
              <div className="connection-picker-head-glance-main has-selection">
                <div
                  className="connection-db-tile-icon connection-picker-head-glance-icon"
                  style={{ "--db-brand": selectedDb.color } as CSSProperties}
                >
                  <DatabaseBrandIcon
                    dbKey={selectedDb.key}
                    label={selectedDb.label}
                    className="connection-db-brand-lg"
                    fallbackClassName="!w-6 !h-6 text-white"
                  />
                </div>

                <div className="connection-picker-head-glance-copy">
                  <div className="connection-picker-head-glance-row">
                    <strong>{selectedDb.label}</strong>
                    <span className={`connection-picker-footer-pill ${selectedStatus.tone}`}>
                      {selectedStatus.label}
                    </span>
                  </div>
                  <span>{selectedMeta}</span>
                  <p>{selectedDescription}</p>
                </div>
              </div>
            ) : (
              <div className="connection-picker-head-glance-main">
                <div className="connection-picker-head-glance-copy">
                  <strong>{bootstrapMode ? strings.pickLocalEngine : strings.pickDatabaseType}</strong>
                  <p>{strings.selectionHint}</p>
                </div>
              </div>
            )}

            <div className="connection-picker-head-glance-meta">
              <span className="connection-picker-head-glance-chip accent">
                <strong>{readyCount}</strong>
                <span>{bootstrapMode ? strings.localReady : strings.ready}</span>
              </span>
              <span className="connection-picker-head-glance-chip">
                <strong>{roadmapTotal}</strong>
                <span>{bootstrapMode ? strings.localRoadmap : strings.roadmap}</span>
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="connection-picker-close"
            title={strings.close}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="connection-picker-body">
        <div className="connection-picker-layout">
          <div className="connection-picker-main">
            <div className="connection-picker-browser">
              <div className="connection-picker-toolbar">
                <div className="connection-picker-searchbar">
                  <Search className="connection-picker-search-icon h-4 w-4 shrink-0" />
                  <input
                    type="text"
                    value={pickerSearch}
                    onChange={(e) => onSearchChange(e.target.value)}
                    placeholder={strings.searchPlaceholder}
                    className="connection-picker-search-input"
                    autoFocus
                  />
                </div>

                <div className="connection-picker-filter-row">
                  {pickerSections.map((section) => (
                    <span key={section.key} className="connection-picker-filter-pill">
                      <strong>{section.items.length}</strong>
                      <span>{section.title}</span>
                    </span>
                  ))}
                </div>
              </div>

              <div className="connection-picker-grid-shell">
                {filteredDbs.length === 0 ? (
                  <div className="connection-picker-empty">
                    <Search className="w-4 h-4" />
                    <span>{strings.emptySearch}</span>
                  </div>
                ) : (
                  pickerSections.map((section) => (
                    <section
                      key={section.key}
                      className="connection-picker-section"
                      data-tone={section.key.includes("roadmap") ? "roadmap" : "ready"}
                    >
                      <div className="connection-picker-section-head">
                        <div className="connection-picker-section-copy">
                          <h3 className="connection-picker-section-title">{section.title}</h3>
                          <p className="connection-picker-section-caption">{section.caption}</p>
                        </div>
                        <span className="connection-picker-section-count">{section.items.length}</span>
                      </div>

                      <div className="connection-picker-grid">
                        {section.items.map((db) => {
                          const brandStyle = { "--db-brand": db.color } as CSSProperties;
                          const isSelected = selectedDb?.key === db.key;
                          const status = getPickerStatus(db, bootstrapMode, language);

                          return (
                            <button
                              key={db.key}
                              type="button"
                              onClick={() => onSelectDb(db)}
                              onDoubleClick={() => {
                                if (status.canContinue) {
                                  onDoubleClickDb(db);
                                }
                              }}
                              className={[
                                "connection-picker-card",
                                status.tone,
                                isSelected ? "selected" : "",
                              ].join(" ")}
                              data-tone={status.tone}
                            >
                              <div className="connection-picker-card-top">
                                <div className="connection-db-tile-icon" style={brandStyle}>
                                  <DatabaseBrandIcon
                                    dbKey={db.key}
                                    label={db.label}
                                    className="connection-db-brand-lg"
                                    fallbackClassName="!w-6 !h-6 text-white"
                                  />
                                </div>

                                <div className="connection-picker-card-copy">
                                  <div className="connection-picker-card-head">
                                    <span className="connection-picker-card-title">{db.label}</span>
                                    <span className={`connection-picker-card-status ${status.tone}`}>
                                      {status.label}
                                    </span>
                                  </div>
                                  <span className="connection-picker-card-meta">{getPickerMetaLabel(db, language)}</span>
                                  <span className="connection-picker-card-note">
                                    {getPickerDescription(db, bootstrapMode, language)}
                                  </span>
                                </div>
                              </div>

                              <div className="connection-picker-card-footer">
                                <div className="connection-picker-card-tags">
                                  {getPickerCapabilities(db, bootstrapMode, language).map((capability) => (
                                    <span key={`${db.key}-${capability}`} className="connection-picker-card-tag">
                                      {capability}
                                    </span>
                                  ))}
                                </div>
                                <span className="connection-picker-card-hint">
                                  {status.canContinue ? strings.doubleClickContinue : strings.previewOnly}
                                </span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </div>
          </div>

          <aside className="connection-picker-aside">
            <div className={`connection-picker-selection-card ${selectedDb ? "has-selection" : ""}`}>
              <span className="connection-picker-footer-label">{strings.selection}</span>

              {selectedDb && selectedStatus ? (
                <>
                  <div className="connection-picker-selection-head">
                    <div
                      className="connection-db-tile-icon connection-picker-selection-icon"
                      style={{ "--db-brand": selectedDb.color } as CSSProperties}
                    >
                      <DatabaseBrandIcon
                        dbKey={selectedDb.key}
                        label={selectedDb.label}
                        className="connection-db-brand-lg"
                        fallbackClassName="!w-6 !h-6 text-white"
                      />
                    </div>

                    <div className="connection-picker-selection-copy">
                      <strong>{selectedDb.label}</strong>
                      <span className={`connection-picker-footer-pill ${selectedStatus.tone}`}>
                        {selectedStatus.label}
                      </span>
                    </div>
                  </div>

                  <p className="connection-picker-selection-description">{selectedDescription}</p>

                  <div className="connection-picker-selection-tags">
                    {selectedCapabilities.map((capability) => (
                      <span key={capability} className="connection-picker-selection-tag">
                        {capability}
                      </span>
                    ))}
                  </div>

                  <div className="connection-picker-selection-meta">
                    <div className="connection-picker-selection-meta-item">
                      <span>{strings.workflow}</span>
                      <strong>{selectedMeta}</strong>
                    </div>
                    <div className="connection-picker-selection-meta-item">
                      <span>{strings.mode}</span>
                      <strong>{bootstrapMode ? strings.localBootstrap : strings.connectionSetup}</strong>
                    </div>
                    <div className="connection-picker-selection-meta-item">
                      <span>{strings.availability}</span>
                      <strong>{selectedStatus.label}</strong>
                    </div>
                    <div className="connection-picker-selection-meta-item">
                      <span>{strings.engineType}</span>
                      <strong>{selectedDb.isFile ? strings.fileDatabase : strings.serverDatabase}</strong>
                    </div>
                  </div>

                  <div className="connection-picker-selection-list">
                    {selectedHighlights.map((highlight) => (
                      <div key={highlight} className="connection-picker-selection-list-item">
                        {highlight}
                      </div>
                    ))}
                  </div>

                  {!bootstrapMode && LOCAL_BOOTSTRAP_READY.has(selectedDb.key) && (
                    <button
                      type="button"
                      className="connection-picker-selection-switch"
                      onClick={() => onSwitchIntent("bootstrap")}
                    >
                      <Database className="w-3.5 h-3.5" />
                      <span>{strings.createFreshLocalInstead}</span>
                    </button>
                  )}

                  {bootstrapMode && (
                    <div className="connection-picker-selection-note">
                      {strings.prismaNote}
                    </div>
                  )}
                </>
              ) : (
                <div className="connection-picker-selection-empty">
                  <strong>
                    {bootstrapMode ? strings.pickLocalEngine : strings.pickDatabaseType}
                  </strong>
                  <span>{strings.selectionHint}</span>
                </div>
              )}

              <div className="connection-picker-footer-actions">
                <button onClick={onClose} className="btn btn-secondary">{strings.cancel}</button>
                <button
                  onClick={onContinue}
                  disabled={!selectedDb || !selectedStatus?.canContinue}
                  className="btn btn-primary"
                >
                  {strings.continue}
                </button>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}

export { LOCAL_BOOTSTRAP_PLANNED, LOCAL_BOOTSTRAP_READY };
export { getPickerStatus, getPickerMetaLabel, getPickerDescription, getPickerCapabilities, getPickerHighlights };
