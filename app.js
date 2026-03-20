// Data Management
class WarehouseManager {
    constructor() {
        this.apiStateUrl = '/api/state';
        this.migrateApiUrl = '/api/migrate-local-state';
        this.localMigrationDoneKey = 'mongoLocalMigrationDone';
        this.products = [];
        this.imports = [];
        this.exports = [];
        this.monthlySnapshots = [];
        this.adjustments = [];
        this.revenueTransactions = [];
        this.pendingSavePayload = {};
        this.saveDebounceTimer = null;
        this.isFlushingSave = false;
        this.isUsingLocalFallback = false;
        this.hasUnsyncedChanges = false;
    }

    getStateKeys() {
        return ['products', 'imports', 'exports', 'adjustments', 'monthlySnapshots', 'revenueTransactions'];
    }

    normalizeState(state) {
        const source = state || {};
        const normalized = {};

        this.getStateKeys().forEach((key) => {
            normalized[key] = Array.isArray(source[key]) ? source[key] : [];
        });

        return normalized;
    }

    applyState(state) {
        const normalized = this.normalizeState(state);
        this.products = normalized.products;
        this.imports = normalized.imports;
        this.exports = normalized.exports;
        this.adjustments = normalized.adjustments;
        this.monthlySnapshots = normalized.monthlySnapshots;
        this.revenueTransactions = normalized.revenueTransactions;
    }

    getCurrentStateSnapshot() {
        return this.normalizeState({
            products: this.products,
            imports: this.imports,
            exports: this.exports,
            adjustments: this.adjustments,
            monthlySnapshots: this.monthlySnapshots,
            revenueTransactions: this.revenueTransactions
        });
    }

    getLocalStateSnapshot() {
        return this.normalizeState({
            products: this.loadData('products') || [],
            imports: this.loadData('imports') || [],
            exports: this.loadData('exports') || [],
            adjustments: this.loadData('adjustments') || [],
            monthlySnapshots: this.loadData('monthlySnapshots') || [],
            revenueTransactions: this.loadData('revenueTransactions') || []
        });
    }

    hasAnyStateData(state) {
        const normalized = this.normalizeState(state);
        return this.getStateKeys().some((key) => normalized[key].length > 0);
    }

    updateDbStatusIndicator(status) {
        const indicator = document.getElementById('dbStatusIndicator');
        if (!indicator) return;

        if (status === 'connected') {
            indicator.innerHTML = '<i class="bi bi-cloud-check-fill text-success"></i> MongoDB online';
            return;
        }

        if (status === 'fallback') {
            indicator.innerHTML = '<i class="bi bi-cloud-slash-fill text-warning"></i> MongoDB offline (local)';
            return;
        }

        indicator.innerHTML = '<i class="bi bi-cloud-fill text-info"></i> Đang kiểm tra MongoDB';
    }

    loadData(key) {
        const data = localStorage.getItem(key);
        return data ? JSON.parse(data) : null;
    }

    async loadInitialData() {
        this.updateDbStatusIndicator('checking');

        try {
            const response = await fetch(this.apiStateUrl);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const serverState = await response.json();
            this.applyState(serverState);
            this.isUsingLocalFallback = false;
            this.hasUnsyncedChanges = false;
            this.updateDbStatusIndicator('connected');
        } catch (error) {
            console.warn('⚠️ Không thể tải dữ liệu từ MongoDB API, dùng dữ liệu local tạm thời.', error);
            this.applyState(this.getLocalStateSnapshot());
            this.isUsingLocalFallback = true;
            this.hasUnsyncedChanges = false;
            this.updateDbStatusIndicator('fallback');
        }
    }

    refreshCurrentSection() {
        const currentSection = document.querySelector('.content-section[style*="display: block"]');
        if (currentSection && currentSection.id) {
            this.showSection(currentSection.id);
            return;
        }

        this.updateDashboard();
    }

    async reloadFromMongoDB() {
        const reloadBtn = document.getElementById('reloadDbBtn');
        const originalBtnHtml = reloadBtn ? reloadBtn.innerHTML : '';

        if (reloadBtn) {
            reloadBtn.disabled = true;
            reloadBtn.innerHTML = '<i class="bi bi-arrow-repeat"></i> Đang tải...';
        }

        try {
            const response = await fetch(this.apiStateUrl, { cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const serverState = await response.json();
            this.applyState(serverState);
            this.pendingSavePayload = {};
            this.hasUnsyncedChanges = false;
            this.updateDbStatusIndicator('connected');
            this.refreshCurrentSection();

            const indicator = document.getElementById('autoSaveIndicator');
            if (indicator) {
                indicator.innerHTML = '<i class="bi bi-arrow-clockwise text-info"></i> Đã tải lại từ MongoDB';
                indicator.style.opacity = '1';
                setTimeout(() => {
                    indicator.style.opacity = '0';
                }, 2000);
            }
        } catch (error) {
            console.error('❌ Không thể tải lại dữ liệu từ MongoDB:', error);
            this.updateDbStatusIndicator('fallback');
            alert('❌ Không thể tải lại dữ liệu từ MongoDB. Vui lòng thử lại.');
        } finally {
            if (reloadBtn) {
                reloadBtn.disabled = false;
                reloadBtn.innerHTML = originalBtnHtml;
            }
        }
    }

    async migrateLocalDataToMongoOnce() {
        if (this.isUsingLocalFallback) return;
        if (localStorage.getItem(this.localMigrationDoneKey) === '1') return;

        const serverState = this.getCurrentStateSnapshot();
        if (this.hasAnyStateData(serverState)) {
            localStorage.setItem(this.localMigrationDoneKey, '1');
            return;
        }

        const localState = this.getLocalStateSnapshot();
        if (!this.hasAnyStateData(localState)) {
            localStorage.setItem(this.localMigrationDoneKey, '1');
            return;
        }

        try {
            const response = await fetch(this.migrateApiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(localState)
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const result = await response.json();
            if (result && result.state) {
                this.applyState(result.state);
            }

            this.pendingSavePayload = {};
            this.hasUnsyncedChanges = false;

            localStorage.setItem(this.localMigrationDoneKey, '1');
            const indicator = document.getElementById('autoSaveIndicator');
            if (indicator) {
                indicator.innerHTML = '<i class="bi bi-cloud-upload-fill text-success"></i> Đã migrate dữ liệu cũ';
                indicator.style.opacity = '1';
                setTimeout(() => {
                    indicator.style.opacity = '0';
                }, 2500);
            }
        } catch (error) {
            console.warn('⚠️ Không thể migrate dữ liệu local lên MongoDB.', error);
        }
    }

    saveData(key, data) {
        this[key] = data;
        localStorage.setItem(key, JSON.stringify(data));
        this.hasUnsyncedChanges = true;
        this.queueServerSave({ [key]: data });
        this.showAutoSaveIndicator();
    }

    saveAllData() {
        this.getStateKeys().forEach((key) => {
            this.saveData(key, this[key]);
        });
    }

    queueServerSave(partialState) {
        this.pendingSavePayload = {
            ...this.pendingSavePayload,
            ...partialState
        };

        if (this.saveDebounceTimer) {
            clearTimeout(this.saveDebounceTimer);
        }

        this.saveDebounceTimer = setTimeout(() => {
            this.flushPendingSaves();
        }, 500);
    }

    async flushPendingSaves(useKeepAlive = false) {
        if (this.isFlushingSave) return;

        const payload = { ...this.pendingSavePayload };
        if (Object.keys(payload).length === 0) return;

        this.pendingSavePayload = {};
        this.isFlushingSave = true;

        try {
            if (useKeepAlive) {
                fetch(this.apiStateUrl, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    keepalive: true
                }).catch((error) => {
                    console.error('❌ Lưu dữ liệu trước khi thoát thất bại:', error);
                    this.updateDbStatusIndicator('fallback');
                });
            } else {
                const response = await fetch(this.apiStateUrl, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                this.updateDbStatusIndicator('connected');
                if (Object.keys(this.pendingSavePayload).length === 0) {
                    this.hasUnsyncedChanges = false;
                }
            }
        } catch (error) {
            console.error('❌ Không thể lưu dữ liệu lên MongoDB API:', error);
            this.updateDbStatusIndicator('fallback');
            this.hasUnsyncedChanges = true;
            this.pendingSavePayload = {
                ...payload,
                ...this.pendingSavePayload
            };
        } finally {
            this.isFlushingSave = false;

            if (!useKeepAlive && Object.keys(this.pendingSavePayload).length > 0) {
                this.queueServerSave({});
            }
        }
    }

    showAutoSaveIndicator() {
        const indicator = document.getElementById('autoSaveIndicator');
        if (!indicator) return;
        
        indicator.innerHTML = '<i class="bi bi-check-circle-fill text-success"></i> Đã lưu';
        indicator.style.opacity = '1';
        
        // Fade out after 2 seconds
        setTimeout(() => {
            indicator.style.opacity = '0';
        }, 2000);
    }

    async initializeApp() {
        await this.loadInitialData();
        await this.migrateLocalDataToMongoOnce();

        // Initialize with sample data if empty
        if (this.products.length === 0) {
            this.initializeSampleData();
        }
        this.setupEventListeners();
        this.initializeReportFilters();
        this.showSection('dashboard');
        this.updateDashboard();
        this.setupAutoSave();
        this.setupBeforeUnload();
    }

    initializeReportFilters() {
        const dateInput = document.getElementById('dailyReportDate');
        if (dateInput && !dateInput.value) {
            dateInput.value = this.getTodayDateValue();
        }

        const monthInput = document.getElementById('monthlyReportMonth');
        if (monthInput && !monthInput.value) {
            monthInput.value = this.getCurrentMonthValue();
        }

        const yearInput = document.getElementById('yearlyReportYear');
        if (yearInput && !yearInput.value) {
            yearInput.value = this.getCurrentYearValue();
        }

        const revenueDateInput = document.getElementById('revenueFilterDate');
        if (revenueDateInput && !revenueDateInput.value) {
            revenueDateInput.value = this.getTodayDateValue();
        }

        const revenueMonthInput = document.getElementById('revenueFilterMonth');
        if (revenueMonthInput && !revenueMonthInput.value) {
            revenueMonthInput.value = this.getCurrentMonthValue();
        }

        const revenueYearInput = document.getElementById('revenueFilterYear');
        if (revenueYearInput && !revenueYearInput.value) {
            revenueYearInput.value = this.getCurrentYearValue();
        }

        const incomeDateInput = document.getElementById('incomeDate');
        if (incomeDateInput && !incomeDateInput.value) {
            incomeDateInput.value = this.getTodayDateValue();
        }

        const expenseDateInput = document.getElementById('expenseDate');
        if (expenseDateInput && !expenseDateInput.value) {
            expenseDateInput.value = this.getTodayDateValue();
        }

        const adjustmentDateInput = document.getElementById('adjustmentDate');
        if (adjustmentDateInput && !adjustmentDateInput.value) {
            adjustmentDateInput.value = this.getTodayDateValue();
        }

        this.updateRevenuePeriodInputsVisibility();
    }

    getTodayDateValue() {
        return new Date().toISOString().split('T')[0];
    }

    getCurrentMonthValue() {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    getCurrentYearValue() {
        return String(new Date().getFullYear());
    }

    updateRevenuePeriodInputsVisibility() {
        const period = document.getElementById('revenueFilterPeriod')?.value || 'all';
        const dateInput = document.getElementById('revenueFilterDate');
        const monthInput = document.getElementById('revenueFilterMonth');
        const yearInput = document.getElementById('revenueFilterYear');

        if (dateInput) {
            dateInput.style.display = period === 'day' ? 'inline-block' : 'none';
        }

        if (monthInput) {
            monthInput.style.display = period === 'month' ? 'inline-block' : 'none';
        }

        if (yearInput) {
            yearInput.style.display = period === 'year' ? 'inline-block' : 'none';
        }
    }

    toDateInputValue(dateString) {
        const date = new Date(dateString);
        if (Number.isNaN(date.getTime())) return this.getTodayDateValue();

        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    buildIsoFromDateInput(dateValue, fallbackIso = null) {
        const [yearText, monthText, dayText] = (dateValue || '').split('-');
        const year = parseInt(yearText, 10);
        const month = parseInt(monthText, 10);
        const day = parseInt(dayText, 10);

        if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) {
            return fallbackIso || new Date().toISOString();
        }

        const timeSource = fallbackIso ? new Date(fallbackIso) : new Date();
        const hours = Number.isNaN(timeSource.getTime()) ? 12 : timeSource.getHours();
        const minutes = Number.isNaN(timeSource.getTime()) ? 0 : timeSource.getMinutes();
        const seconds = Number.isNaN(timeSource.getTime()) ? 0 : timeSource.getSeconds();

        return new Date(year, month - 1, day, hours, minutes, seconds, 0).toISOString();
    }

    setImportDateDefault(force = false) {
        const input = document.getElementById('importDate');
        if (!input) return;
        if (force || !input.value) {
            input.value = this.getTodayDateValue();
        }
    }

    setExportDateDefault(force = false) {
        const input = document.getElementById('exportDate');
        if (!input) return;
        if (force || !input.value) {
            input.value = this.getTodayDateValue();
        }
    }

    setAdjustmentDateDefault(force = false) {
        const input = document.getElementById('adjustmentDate');
        if (!input) return;
        if (force || !input.value) {
            input.value = this.getTodayDateValue();
        }
    }

    isSameDate(dateString, targetDate) {
        const date = new Date(dateString);
        return !Number.isNaN(date.getTime()) && date.toDateString() === targetDate.toDateString();
    }

    calculateInventoryAt(cutoffDate) {
        const validCutoff = cutoffDate instanceof Date && !Number.isNaN(cutoffDate.getTime())
            ? cutoffDate
            : new Date();

        const inventory = this.products.map((product) => ({ ...product }));
        const stockByProductId = new Map(inventory.map((product) => [product.id, Number(product.stock) || 0]));

        this.imports.forEach((imp) => {
            const date = new Date(imp.date);
            if (Number.isNaN(date.getTime()) || date <= validCutoff) return;

            const currentStock = stockByProductId.get(imp.productId);
            if (currentStock === undefined) return;
            stockByProductId.set(imp.productId, currentStock - (Number(imp.quantity) || 0));
        });

        this.exports.forEach((exp) => {
            const date = new Date(exp.date);
            if (Number.isNaN(date.getTime()) || date <= validCutoff) return;

            const currentStock = stockByProductId.get(exp.productId);
            if (currentStock === undefined) return;
            stockByProductId.set(exp.productId, currentStock + (Number(exp.quantity) || 0));
        });

        this.adjustments.forEach((adj) => {
            const date = new Date(adj.date);
            if (Number.isNaN(date.getTime()) || date <= validCutoff) return;

            const currentStock = stockByProductId.get(adj.productId);
            if (currentStock === undefined) return;

            let delta = 0;
            if (Number.isFinite(Number(adj.newStock)) && Number.isFinite(Number(adj.oldStock))) {
                delta = Number(adj.newStock) - Number(adj.oldStock);
            } else {
                const qty = Number(adj.quantity) || 0;
                delta = adj.type === 'increase' ? qty : -qty;
            }

            stockByProductId.set(adj.productId, currentStock - delta);
        });

        inventory.forEach((product) => {
            const adjustedStock = stockByProductId.get(product.id);
            product.stock = Number.isFinite(adjustedStock) ? adjustedStock : 0;
        });

        const totalInventoryValue = inventory.reduce((sum, product) => {
            return sum + ((Number(product.stock) || 0) * (Number(product.costPrice) || 0));
        }, 0);

        const lowStockItems = inventory.filter((product) => product.stock <= product.minStock && product.stock > 0);
        const outOfStockItems = inventory.filter((product) => product.stock <= 0);

        return {
            inventory,
            totalInventoryValue,
            lowStockItems,
            outOfStockItems,
            cutoffDate: validCutoff
        };
    }

    showInventorySnapshotModal({ title, cutoffLabel, snapshot }) {
        const modalContent = `
            <div class="modal fade" id="inventorySnapshotModal" tabindex="-1">
                <div class="modal-dialog modal-xl">
                    <div class="modal-content">
                        <div class="modal-header bg-primary text-white">
                            <h5 class="modal-title">
                                <i class="bi bi-box-seam"></i> ${title}
                            </h5>
                            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body">
                            <div class="row mb-3">
                                <div class="col-md-3">
                                    <div class="card border-primary">
                                        <div class="card-body text-center p-2">
                                            <h6 class="mb-1">${this.formatCurrency(snapshot.totalInventoryValue)}</h6>
                                            <small class="text-muted">Giá trị tồn kho</small>
                                        </div>
                                    </div>
                                </div>
                                <div class="col-md-3">
                                    <div class="card border-success">
                                        <div class="card-body text-center p-2">
                                            <h6 class="mb-1">${snapshot.inventory.length}</h6>
                                            <small class="text-muted">Tổng mặt hàng</small>
                                        </div>
                                    </div>
                                </div>
                                <div class="col-md-3">
                                    <div class="card border-warning">
                                        <div class="card-body text-center p-2">
                                            <h6 class="mb-1">${snapshot.lowStockItems.length}</h6>
                                            <small class="text-muted">Sắp hết</small>
                                        </div>
                                    </div>
                                </div>
                                <div class="col-md-3">
                                    <div class="card border-danger">
                                        <div class="card-body text-center p-2">
                                            <h6 class="mb-1">${snapshot.outOfStockItems.length}</h6>
                                            <small class="text-muted">Hết hàng</small>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <p class="text-muted mb-3"><small><i class="bi bi-clock-history"></i> Mốc tồn kho: ${cutoffLabel}</small></p>

                            <div class="table-responsive" style="max-height: 520px; overflow-y: auto;">
                                <table class="table table-striped table-sm">
                                    <thead class="sticky-top bg-white">
                                        <tr>
                                            <th>Mã</th>
                                            <th>Tên sản phẩm</th>
                                            <th>Đơn vị</th>
                                            <th>Tồn kho</th>
                                            <th>Giá vốn</th>
                                            <th>Giá trị</th>
                                            <th>Trạng thái</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${snapshot.inventory.map((product) => {
                                            const stockValue = (Number(product.stock) || 0) * (Number(product.costPrice) || 0);
                                            let status = 'Đủ hàng';
                                            let statusClass = 'bg-success';

                                            if ((Number(product.stock) || 0) <= 0) {
                                                status = 'Hết hàng';
                                                statusClass = 'bg-danger';
                                            } else if ((Number(product.stock) || 0) <= (Number(product.minStock) || 0)) {
                                                status = 'Sắp hết';
                                                statusClass = 'bg-warning';
                                            }

                                            return `
                                                <tr>
                                                    <td>${product.code}</td>
                                                    <td>${product.name}</td>
                                                    <td>${product.unit}</td>
                                                    <td><strong>${product.stock}</strong></td>
                                                    <td>${this.formatCurrency(product.costPrice)}</td>
                                                    <td><strong>${this.formatCurrency(stockValue)}</strong></td>
                                                    <td><span class="badge ${statusClass}">${status}</span></td>
                                                </tr>
                                            `;
                                        }).join('')}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const oldModal = document.getElementById('inventorySnapshotModal');
        if (oldModal) oldModal.remove();

        document.body.insertAdjacentHTML('beforeend', modalContent);
        const modal = new bootstrap.Modal(document.getElementById('inventorySnapshotModal'));
        modal.show();
    }

    showInventoryByDay() {
        const selectedDateValue = document.getElementById('dailyReportDate')?.value || this.getTodayDateValue();
        const endOfDay = new Date(`${selectedDateValue}T23:59:59.999`);

        if (Number.isNaN(endOfDay.getTime())) {
            alert('❌ Ngày báo cáo không hợp lệ!');
            return;
        }

        const snapshot = this.calculateInventoryAt(endOfDay);
        this.showInventorySnapshotModal({
            title: 'Tồn Kho Theo Ngày',
            cutoffLabel: endOfDay.toLocaleString('vi-VN'),
            snapshot
        });
    }

    showInventoryByMonth() {
        const monthValue = document.getElementById('monthlyReportMonth')?.value || this.getCurrentMonthValue();
        const [yearText, monthText] = monthValue.split('-');
        const year = parseInt(yearText, 10);
        const monthIndex = parseInt(monthText, 10) - 1;

        if (Number.isNaN(year) || Number.isNaN(monthIndex) || monthIndex < 0 || monthIndex > 11) {
            alert('❌ Tháng báo cáo không hợp lệ!');
            return;
        }

        const endOfMonth = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
        const snapshot = this.calculateInventoryAt(endOfMonth);
        this.showInventorySnapshotModal({
            title: 'Tồn Kho Theo Tháng',
            cutoffLabel: endOfMonth.toLocaleString('vi-VN'),
            snapshot
        });
    }

    showInventoryByYear() {
        const yearValue = document.getElementById('yearlyReportYear')?.value || this.getCurrentYearValue();
        const year = parseInt(yearValue, 10);

        if (Number.isNaN(year) || year < 2000 || year > 2100) {
            alert('❌ Năm báo cáo không hợp lệ!');
            return;
        }

        const endOfYear = new Date(year, 11, 31, 23, 59, 59, 999);
        const snapshot = this.calculateInventoryAt(endOfYear);
        this.showInventorySnapshotModal({
            title: 'Tồn Kho Theo Năm',
            cutoffLabel: endOfYear.toLocaleString('vi-VN'),
            snapshot
        });
    }

    initializeSampleData() {
        // Không có dữ liệu mẫu - bắt đầu với kho trống
        const sampleProducts = [];
        this.products = sampleProducts;
        this.saveData('products', this.products);
    }

    setupEventListeners() {
        // Navigation
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const section = e.currentTarget.getAttribute('data-section');
                this.showSection(section);
                
                document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
                e.currentTarget.classList.add('active');
            });
        });

        // Forms
        document.getElementById('productForm').addEventListener('submit', (e) => e.preventDefault());
        document.getElementById('importForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const mode = document.getElementById('importMode').value;
            if (mode === 'edit') {
                this.updateImport();
            } else {
                this.handleImport();
            }
        });
        document.getElementById('exportForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const mode = document.getElementById('exportMode').value;
            if (mode === 'edit') {
                this.updateExport();
            } else {
                this.handleExport();
            }
        });

        // Adjustment form
        document.getElementById('adjustmentForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const mode = document.getElementById('adjustmentMode').value;
            if (mode === 'edit') {
                this.saveAdjustmentEdit();
            } else {
                this.handleAdjustment();
            }
        });

        // Product selection change for export
        document.getElementById('exportProduct').addEventListener('change', (e) => {
            this.updateExportInfo();
        });


        // Search inventory
        document.getElementById('searchInventory').addEventListener('input', (e) => {
            this.filterInventory(e.target.value);
        });

        document.getElementById('searchProduct').addEventListener('input', (e) => {
            this.filterProducts(e.target.value);
        });

        // Adjustment product selection
        document.getElementById('adjustmentProduct').addEventListener('change', (e) => {
            this.updateAdjustmentInfo();
        });

        // Adjustment form product selection
        document.getElementById('adjustmentProduct').addEventListener('change', () => {
            this.updateAdjustmentInfo();
        });

        // Update base unit label when unit changes
        document.getElementById('productUnit').addEventListener('input', (e) => {
            document.getElementById('productBaseUnitLabel').textContent = e.target.value || 'đơn vị cơ bản';
        });

        // Product selection for import (auto-fill price)
        document.getElementById('importProduct').addEventListener('change', (e) => {
            const productId = parseInt(e.target.value);
            const product = this.products.find(p => p.id === productId);
            if (product) {
                document.getElementById('importPrice').value = product.costPrice;
            }
        });

        // Revenue forms
        document.getElementById('revenueIncomeForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleRevenueIncome();
        });

        document.getElementById('revenueExpenseForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleRevenueExpense();
        });

        // Revenue filters
        document.getElementById('revenueFilterType').addEventListener('change', () => {
            this.displayRevenueSection();
        });

        document.getElementById('revenueFilterPeriod').addEventListener('change', () => {
            this.updateRevenuePeriodInputsVisibility();
            this.displayRevenueSection();
        });

        document.getElementById('revenueFilterDate').addEventListener('change', () => {
            this.displayRevenueSection();
        });

        document.getElementById('revenueFilterMonth').addEventListener('change', () => {
            this.displayRevenueSection();
        });

        document.getElementById('revenueFilterYear').addEventListener('change', () => {
            this.displayRevenueSection();
        });
    }

    showSection(sectionName) {
        document.querySelectorAll('.content-section').forEach(section => {
            section.style.display = 'none';
        });
        document.getElementById(sectionName).style.display = 'block';

        // Update content based on section
        switch(sectionName) {
            case 'dashboard':
                this.updateDashboard();
                break;
            case 'products':
                this.displayProducts();
                break;
            case 'import':
                this.displayImportSection();
                break;
            case 'export':
                this.displayExportSection();
                break;
            case 'inventory':
                this.displayInventory();
                break;
            case 'monthly-report':
                this.displayMonthlyReports();
                break;
            case 'adjustments':
                this.displayAdjustmentsSection();
                break;
            case 'revenue':
                this.displayRevenueSection();
                break;
            case 'statistics':
                this.displayStatistics();
                break;
        }
    }

    // Product Management
    displayProducts() {
        const tbody = document.getElementById('productsTable');
        tbody.innerHTML = this.products.map(product => {
            const stockValue = product.stock * product.costPrice;
            return `
            <tr>
                <td>${product.code}</td>
                <td>${product.name}</td>
                <td>${product.unit}</td>
                <td>${this.formatCurrency(product.costPrice)}</td>
                <td><span class="badge ${this.getStockBadgeClass(product)}">${product.stock}</span></td>
                <td><strong>${this.formatCurrency(stockValue)}</strong></td>
                <td>
                    <button class="btn btn-sm btn-warning" onclick="app.editProduct(${product.id})">
                        <i class="bi bi-pencil"></i>
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="app.deleteProduct(${product.id})">
                        <i class="bi bi-trash"></i>
                    </button>
                </td>
            </tr>
            `;
        }).join('');
    }

    filterProducts(searchTerm) {
        const tbody = document.getElementById('productsTable');
        const filtered = this.products.filter(product => 
            product.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            product.code.toLowerCase().includes(searchTerm.toLowerCase())
        );

        tbody.innerHTML = filtered.map(product => {
            const stockValue = product.stock * product.costPrice;
            return `
            <tr>
                <td>${product.code}</td>
                <td>${product.name}</td>
                <td>${product.unit}</td>
                <td>${this.formatCurrency(product.costPrice)}</td>
                <td><span class="badge ${this.getStockBadgeClass(product)}">${product.stock}</span></td>
                <td><strong>${this.formatCurrency(stockValue)}</strong></td>
                <td>
                    <button class="btn btn-sm btn-warning" onclick="app.editProduct(${product.id})">
                        <i class="bi bi-pencil"></i>
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="app.deleteProduct(${product.id})">
                        <i class="bi bi-trash"></i>
                    </button>
                </td>
            </tr>
            `;
        }).join('');
    }

    getStockBadgeClass(product) {
        if (product.stock === 0) return 'bg-danger';
        if (product.stock <= product.minStock) return 'bg-warning';
        return 'bg-success';
    }

    editProduct(id) {
        const product = this.products.find(p => p.id === id);
        if (product) {
            document.getElementById('productId').value = product.id;
            document.getElementById('productCode').value = product.code;
            document.getElementById('productName').value = product.name;
            document.getElementById('productUnit').value = product.unit;
            document.getElementById('productCostPrice').value = product.costPrice;
            document.getElementById('productSalePrice').value = product.salePrice || product.costPrice;
            document.getElementById('productMinStock').value = product.minStock;
            document.getElementById('productConversionUnit').value = product.conversionUnit || '';
            document.getElementById('productConversionRate').value = product.conversionRate || '';
            document.getElementById('productBaseUnitLabel').textContent = product.unit || 'đơn vị cơ bản';
            document.getElementById('productModalTitle').textContent = 'Chỉnh Sửa Nguyên Liệu';
            new bootstrap.Modal(document.getElementById('productModal')).show();
        }
    }

    deleteProduct(id) {
        if (confirm('⚠️ Bạn có chắc chắn muốn xóa nguyên liệu này?')) {
            this.products = this.products.filter(p => p.id !== id);
            this.saveData('products', this.products);
            this.displayProducts();
            this.updateDashboard();
        }
    }

    // Import Management
    displayImportSection() {
        this.populateProductSelect('importProduct');
        this.setImportDateDefault();
        this.displayImportHistory();
    }

    populateProductSelect(selectId) {
        const select = document.getElementById(selectId);
        select.innerHTML = '<option value="">-- Chọn sản phẩm --</option>' +
            this.products.map(p => `<option value="${p.id}">${p.name} (${p.code})</option>`).join('');
    }

    handleImport() {
        const editId = document.getElementById('importForm').getAttribute('data-edit-id');
        const productId = parseInt(document.getElementById('importProduct').value);
        const importDate = document.getElementById('importDate').value;
        const quantity = parseInt(document.getElementById('importQuantity').value);
        const price = parseFloat(document.getElementById('importPrice').value);
        const supplier = document.getElementById('importSupplier').value;
        const note = document.getElementById('importNote').value;

        if (!productId || !importDate || !quantity || !price || !supplier) {
            alert('Vui lòng điền đầy đủ thông tin!');
            return;
        }

        const product = this.products.find(p => p.id === productId);
        if (!product) return;

        if (editId) {
            // Chế độ sửa
            const importRecord = this.imports.find(i => i.id === parseInt(editId));
            if (importRecord) {
                // Điều chỉnh tồn kho: trừ số lượng cũ và cộng số lượng mới
                product.stock = product.stock - importRecord.quantity + quantity;
                
                // Cập nhật phiếu nhập
                importRecord.quantity = quantity;
                importRecord.price = price;
                importRecord.supplier = supplier;
                importRecord.note = note;
                importRecord.total = quantity * price;
                importRecord.date = this.buildIsoFromDateInput(importDate, importRecord.date);

                this.saveData('imports', this.imports);
                this.saveData('products', this.products);

                // Reset form
                document.getElementById('importForm').removeAttribute('data-edit-id');
                const submitBtn = document.querySelector('#importForm button[type="submit"]');
                submitBtn.innerHTML = '<i class="bi bi-check-circle"></i> Xác Nhận Nhập Kho';
                submitBtn.classList.remove('btn-warning');
                submitBtn.classList.add('btn-success');

                alert('✅ Đã cập nhật phiếu nhập thành công!');
            }
        } else {
            // Chế độ thêm mới
            const importRecord = {
                id: Date.now(),
                date: this.buildIsoFromDateInput(importDate),
                productId: productId,
                productName: product.name,
                quantity: quantity,
                price: price,
                supplier: supplier,
                note: note,
                total: quantity * price
            };

            this.imports.push(importRecord);
            this.saveData('imports', this.imports);

            // Update product stock
            product.stock += quantity;
            this.saveData('products', this.products);

            alert('✅ Nhập kho thành công!');
        }

        // Reset form
        document.getElementById('importForm').reset();
        this.setImportDateDefault(true);
        this.displayImportHistory();
        this.updateDashboard();
    }

    displayImportHistory() {
        const tbody = document.getElementById('importHistory');
        const recentImports = this.imports.slice(-20).reverse();
        tbody.innerHTML = recentImports.map(imp => `
            <tr>
                <td>${this.formatDate(imp.date)}</td>
                <td>${imp.productName}</td>
                <td>${imp.quantity}</td>
                <td>${this.formatCurrency(imp.price)}</td>
                <td>${imp.supplier}</td>
                <td>
                    <button class="btn btn-sm btn-warning" onclick="app.editImport(${imp.id})" title="Sửa">
                        <i class="bi bi-pencil"></i>
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="app.deleteImport(${imp.id})" title="Xóa">
                        <i class="bi bi-trash"></i>
                    </button>
                </td>
            </tr>
        `).join('');
    }

    editImport(id) {
        const importRecord = this.imports.find(i => i.id === id);
        if (!importRecord) return;

        // Set edit mode
        document.getElementById('importMode').value = 'edit';
        document.getElementById('importEditId').value = id;

        // Điền dữ liệu vào form
        document.getElementById('importProduct').value = importRecord.productId;
        document.getElementById('importQuantity').value = importRecord.quantity;
        document.getElementById('importPrice').value = importRecord.price;
        document.getElementById('importSupplier').value = importRecord.supplier;
        document.getElementById('importDate').value = this.toDateInputValue(importRecord.date);
        document.getElementById('importNote').value = importRecord.note || '';

        // Update UI
        document.getElementById('importSubmitText').textContent = 'Cập Nhật Phiếu Nhập';
        const submitBtn = document.getElementById('importSubmitBtn');
        submitBtn.classList.remove('btn-success');
        submitBtn.classList.add('btn-info');
        document.getElementById('importCancelBtn').style.display = 'block';

        // Scroll to form
        document.getElementById('importForm').scrollIntoView({ behavior: 'smooth' });
    }

    cancelImportEdit() {
        // Reset mode
        document.getElementById('importMode').value = 'create';
        document.getElementById('importEditId').value = '';
        
        // Reset form
        document.getElementById('importForm').reset();
        document.getElementById('importSubmitText').textContent = 'Xác Nhận Nhập Kho';
        const submitBtn = document.getElementById('importSubmitBtn');
        submitBtn.classList.remove('btn-info');
        submitBtn.classList.add('btn-success');
        document.getElementById('importCancelBtn').style.display = 'none';
    }

    updateImport() {
        const id = parseInt(document.getElementById('importEditId').value, 10);
        const productId = parseInt(document.getElementById('importProduct').value);
        const quantity = parseFloat(document.getElementById('importQuantity').value);
        const price = parseFloat(document.getElementById('importPrice').value);
        const supplier = document.getElementById('importSupplier').value;
        const selectedDate = document.getElementById('importDate').value || this.getTodayDateValue();
        const note = document.getElementById('importNote').value;

        if (!id || !productId || !quantity || !price || !supplier) {
            alert('⚠️ Vui lòng điền đầy đủ thông tin!');
            return;
        }

        const index = this.imports.findIndex(i => i.id === id);
        if (index === -1) {
            alert('❌ Không tìm thấy bản ghi nhập kho!');
            return;
        }

        const existing = this.imports[index];
        const isoDate = this.buildIsoFromDateInput(selectedDate, existing.date);
        const product = this.products.find(p => p.id === productId);
        
        if (!product) {
            alert('❌ Không tìm thấy sản phẩm!');
            return;
        }

        // Adjust stock: remove old quantity, add new quantity
        if (existing.productId === productId) {
            // Same product
            product.stock = product.stock - existing.quantity + quantity;
        } else {
            // Different product
            const oldProduct = this.products.find(p => p.id === existing.productId);
            if (oldProduct) {
                oldProduct.stock -= existing.quantity;
            }
            product.stock += quantity;
        }

        // Update import record
        this.imports[index] = {
            ...existing,
            productId,
            productName: product.name,
            quantity,
            price,
            supplier,
            date: isoDate,
            note: note.trim() ? note.trim() : '-'
        };

        this.saveData('imports', this.imports);
        this.saveData('products', this.products);
        
        alert('✅ Cập nhật phiếu nhập thành công!');
        
        this.displayImportHistory();
        this.updateDashboard();
        this.cancelImportEdit();
    }

    deleteImport(id) {
        const importRecord = this.imports.find(i => i.id === id);
        if (!importRecord) return;

        if (!confirm(`⚠️ Bạn có chắc chắn muốn xóa phiếu nhập này?\n\nSản phẩm: ${importRecord.productName}\nSố lượng: ${importRecord.quantity}\n\nLưu ý: Tồn kho sẽ bị trừ đi!`)) {
            return;
        }

        // Trừ tồn kho
        const product = this.products.find(p => p.id === importRecord.productId);
        if (product) {
            product.stock -= importRecord.quantity;
            if (product.stock < 0) product.stock = 0;
            this.saveData('products', this.products);
        }

        // Xóa phiếu nhập
        this.imports = this.imports.filter(i => i.id !== id);
        this.saveData('imports', this.imports);

        // Cập nhật hiển thị
        this.displayImportHistory();
        this.updateDashboard();

        alert('✅ Đã xóa phiếu nhập thành công!');
    }

    // Export Management
    displayExportSection() {
        this.populateProductSelect('exportProduct');
        this.setExportDateDefault();
        this.displayExportHistory();
    }

    updateExportInfo() {
        const productId = parseInt(document.getElementById('exportProduct').value);
        if (productId) {
            const product = this.products.find(p => p.id === productId);
            if (product) {
                document.getElementById('exportStockInfo').textContent = product.stock + ' ' + product.unit;
                document.getElementById('exportPrice').value = product.costPrice;
            }
        }
    }

    handleExport() {
        const editId = document.getElementById('exportForm').getAttribute('data-edit-id');
        const productId = parseInt(document.getElementById('exportProduct').value);
        const exportDate = document.getElementById('exportDate').value;
        const quantity = parseInt(document.getElementById('exportQuantity').value);
        const purpose = document.getElementById('exportCustomer').value;
        const note = document.getElementById('exportNote').value;

        if (!productId || !exportDate || !quantity) {
            alert('Vui lòng điền đầy đủ thông tin!');
            return;
        }

        const product = this.products.find(p => p.id === productId);
        if (!product) return;

        if (editId) {
            // Chế độ sửa
            const exportRecord = this.exports.find(e => e.id === parseInt(editId));
            if (exportRecord) {
                // Kiểm tra tồn kho: cộng lại số lượng cũ rồi trừ số lượng mới
                const adjustedStock = product.stock + exportRecord.quantity - quantity;
                if (adjustedStock < 0) {
                    alert(`⚠️ Không đủ nguyên liệu trong kho!\n\nTồn kho hiện tại: ${product.stock + exportRecord.quantity} ${product.unit}\nSố lượng muốn xuất: ${quantity} ${product.unit}`);
                    return;
                }
                
                // Điều chỉnh tồn kho
                product.stock = adjustedStock;
                
                // Cập nhật phiếu xuất
                exportRecord.quantity = quantity;
                exportRecord.purpose = purpose || 'Sản xuất';
                exportRecord.note = note;
                exportRecord.totalCost = quantity * product.costPrice;
                exportRecord.date = this.buildIsoFromDateInput(exportDate, exportRecord.date);

                this.saveData('exports', this.exports);
                this.saveData('products', this.products);

                // Reset form
                document.getElementById('exportForm').removeAttribute('data-edit-id');
                const submitBtn = document.querySelector('#exportForm button[type="submit"]');
                submitBtn.innerHTML = '<i class="bi bi-check-circle"></i> Xác Nhận Xuất Nguyên Liệu';
                submitBtn.classList.remove('btn-info');
                submitBtn.classList.add('btn-warning');

                alert('✅ Đã cập nhật phiếu xuất thành công!');
            }
        } else {
            // Chế độ thêm mới
            // Check stock
            if (product.stock < quantity) {
                alert(`⚠️ Không đủ nguyên liệu trong kho!\n\nTồn kho hiện tại: ${product.stock} ${product.unit}`);
                return;
            }

            // Add to export history
            const exportRecord = {
                id: Date.now(),
                date: this.buildIsoFromDateInput(exportDate),
                productId: productId,
                productName: product.name,
                quantity: quantity,
                unit: product.unit,
                purpose: purpose || 'Sản xuất',
                note: note,
                costPrice: product.costPrice,
                totalCost: quantity * product.costPrice
            };

            this.exports.push(exportRecord);
            this.saveData('exports', this.exports);

            // Update product stock
            product.stock -= quantity;
            this.saveData('products', this.products);

            alert(`✅ Xuất nguyên liệu thành công!\n\n${product.name}: ${quantity} ${product.unit}`);
        }

        // Reset form
        document.getElementById('exportForm').reset();
        this.setExportDateDefault(true);
        document.getElementById('exportStockInfo').textContent = '0';
        this.displayExportHistory();
        this.updateDashboard();
    }

    displayExportHistory() {
        const tbody = document.getElementById('exportHistory');
        const recentExports = this.exports.slice(-20).reverse();
        tbody.innerHTML = recentExports.map(exp => `
            <tr>
                <td>${this.formatDate(exp.date)}</td>
                <td>${exp.productName}</td>
                <td>${exp.quantity} ${exp.unit || ''}</td>
                <td>${exp.purpose || exp.customer || 'Sản xuất'}</td>
                <td>${exp.note || '-'}</td>
                <td>
                    <button class="btn btn-sm btn-warning" onclick="app.editExport(${exp.id})" title="Sửa">
                        <i class="bi bi-pencil"></i>
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="app.deleteExport(${exp.id})" title="Xóa">
                        <i class="bi bi-trash"></i>
                    </button>
                </td>
            </tr>
        `).join('');
    }

    editExport(id) {
        const exportRecord = this.exports.find(e => e.id === id);
        if (!exportRecord) return;

        // Set edit mode
        document.getElementById('exportMode').value = 'edit';
        document.getElementById('exportEditId').value = id;

        // Điền dữ liệu vào form
        document.getElementById('exportProduct').value = exportRecord.productId;
        this.updateExportInfo();
        document.getElementById('exportQuantity').value = exportRecord.quantity;
        document.getElementById('exportDate').value = this.toDateInputValue(exportRecord.date);
        document.getElementById('exportCustomer').value = exportRecord.purpose || exportRecord.customer || '';
        document.getElementById('exportNote').value = exportRecord.note || '';

        // Update UI
        document.getElementById('exportSubmitText').textContent = 'Cập Nhật Phiếu Xuất';
        const submitBtn = document.getElementById('exportSubmitBtn');
        submitBtn.classList.remove('btn-warning');
        submitBtn.classList.add('btn-info');
        document.getElementById('exportCancelBtn').style.display = 'block';

        // Scroll to form
        document.getElementById('exportForm').scrollIntoView({ behavior: 'smooth' });
    }

    cancelExportEdit() {
        // Reset mode
        document.getElementById('exportMode').value = 'create';
        document.getElementById('exportEditId').value = '';
        
        // Reset form
        document.getElementById('exportForm').reset();
        document.getElementById('exportSubmitText').textContent = 'Xác Nhận Xuất Nguyên Liệu';
        const submitBtn = document.getElementById('exportSubmitBtn');
        submitBtn.classList.remove('btn-info');
        submitBtn.classList.add('btn-warning');
        document.getElementById('exportCancelBtn').style.display = 'none';
    }

    updateExport() {
        const id = parseInt(document.getElementById('exportEditId').value, 10);
        const productId = parseInt(document.getElementById('exportProduct').value);
        const quantity = parseFloat(document.getElementById('exportQuantity').value);
        const selectedDate = document.getElementById('exportDate').value || this.getTodayDateValue();
        const customer = document.getElementById('exportCustomer').value;
        const note = document.getElementById('exportNote').value;

        if (!id || !productId || !quantity || !customer) {
            alert('⚠️ Vui lòng điền đầy đủ thông tin!');
            return;
        }

        const index = this.exports.findIndex(e => e.id === id);
        if (index === -1) {
            alert('❌ Không tìm thấy bản ghi xuất!');
            return;
        }

        const existing = this.exports[index];
        const isoDate = this.buildIsoFromDateInput(selectedDate, existing.date);
        const product = this.products.find(p => p.id === productId);
        
        if (!product) {
            alert('❌ Không tìm thấy sản phẩm!');
            return;
        }

        // Adjust stock: add back old quantity, remove new quantity
        if (existing.productId === productId) {
            // Same product
            product.stock = product.stock + existing.quantity - quantity;
            if (product.stock < 0) {
                alert(`⚠️ Không đủ tồn kho!

Tồn kho hiện có: ${product.stock + quantity - existing.quantity} ${product.unit}
Số lượng xuất: ${quantity} ${product.unit}`);
                return;
            }
        } else {
            // Different product
            const oldProduct = this.products.find(p => p.id === existing.productId);
            if (oldProduct) {
                oldProduct.stock += existing.quantity;
            }
            product.stock -= quantity;
            if (product.stock < 0) {
                alert(`⚠️ Không đủ tồn kho!`);
                return;
            }
        }

        // Update export record
        this.exports[index] = {
            ...existing,
            productId,
            productName: product.name,
            unit: product.unit,
            quantity,
            purpose: customer,
            customer: customer,
            date: isoDate,
            note: note.trim() ? note.trim() : '-'
        };

        this.saveData('exports', this.exports);
        this.saveData('products', this.products);
        
        alert('✅ Cập nhật phiếu xuất thành công!');
        
        this.displayExportHistory();
        this.updateDashboard();
        this.cancelExportEdit();
    }

    deleteExport(id) {
        const exportRecord = this.exports.find(e => e.id === id);
        if (!exportRecord) return;

        if (!confirm(`⚠️ Bạn có chắc chắn muốn xóa phiếu xuất này?\n\nNguyên liệu: ${exportRecord.productName}\nSố lượng: ${exportRecord.quantity}\n\nLưu ý: Tồn kho sẽ được cộng lại!`)) {
            return;
        }

        // Cộng lại tồn kho
        const product = this.products.find(p => p.id === exportRecord.productId);
        if (product) {
            product.stock += exportRecord.quantity;
            this.saveData('products', this.products);
        }

        // Xóa phiếu xuất
        this.exports = this.exports.filter(e => e.id !== id);
        this.saveData('exports', this.exports);

        // Cập nhật hiển thị
        this.displayExportHistory();
        this.updateDashboard();

        alert('✅ Đã xóa phiếu xuất thành công!');
    }

    // Inventory Management
    displayInventory() {
        this.filterInventory('');
    }

    filterInventory(searchTerm) {
        const tbody = document.getElementById('inventoryTable');
        const filtered = this.products.filter(p => 
            p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            p.code.toLowerCase().includes(searchTerm.toLowerCase())
        );

        tbody.innerHTML = filtered.map(product => {
            const stockValue = product.stock * product.costPrice;
            
            // Xác định trạng thái và class CSS
            let status, statusClass;
            if (product.stock === 0) {
                status = 'Hết hàng';
                statusClass = 'bg-danger';
            } else if (product.stock <= product.minStock) {
                status = 'Sắp hết';
                statusClass = 'bg-warning';
            } else {
                status = 'Đủ hàng';
                statusClass = 'bg-success';
            }
            
            return `
                <tr>
                    <td>${product.code}</td>
                    <td>${product.name}</td>
                    <td>${product.unit}</td>
                    <td><strong>${product.stock}</strong></td>
                    <td>${this.formatCurrency(stockValue)}</td>
                    <td><span class="badge ${statusClass}">${status}</span></td>
                </tr>
            `;
        }).join('');
    }

    // Dashboard
    updateDashboard() {
        // Update statistics cards
        document.getElementById('totalProducts').textContent = this.products.length;
        
        const totalStockValue = this.products.reduce((sum, p) => sum + (p.stock * p.costPrice), 0);
        document.getElementById('totalInventory').textContent = this.formatCurrency(totalStockValue);

        const today = new Date().toDateString();
        const todayImports = this.imports.filter(i => new Date(i.date).toDateString() === today);
        const todayImportQty = todayImports.reduce((sum, i) => sum + i.quantity, 0);
        document.getElementById('todayImport').textContent = todayImportQty;

        const todayExports = this.exports.filter(e => new Date(e.date).toDateString() === today);
        const todayExportQty = todayExports.reduce((sum, e) => sum + e.quantity, 0);
        document.getElementById('todayExport').textContent = todayExportQty;

        // Update low stock products
        this.displayLowStockProducts();
        
        // Update charts
        this.updateWeeklyRevenueChart();
    }

    displayLowStockProducts() {
        const lowStock = this.products.filter(p => p.stock <= p.minStock);
        const container = document.getElementById('lowStockProducts');
        
        if (lowStock.length === 0) {
            container.innerHTML = '<p class="text-success">Tất cả sản phẩm đều đủ hàng!</p>';
        } else {
            container.innerHTML = lowStock.map(p => `
                <div class="${p.stock === 0 ? 'out-of-stock-item' : 'low-stock-item'}">
                    <strong>${p.name}</strong><br>
                    <small>Còn lại: ${p.stock} ${p.unit}</small>
                </div>
            `).join('');
        }
    }

    updateWeeklyRevenueChart() {
        const ctx = document.getElementById('weeklyRevenueChart');
        if (!ctx) return;

        const last7Days = [...Array(7)].map((_, i) => {
            const date = new Date();
            date.setDate(date.getDate() - (6 - i));
            return date;
        });

        const revenueData = last7Days.map(date => {
            const dayExports = this.exports.filter(e => 
                new Date(e.date).toDateString() === date.toDateString()
            );
            return dayExports.reduce((sum, e) => sum + (e.totalCost || e.quantity * e.costPrice || 0), 0);
        });

        const labels = last7Days.map(d => {
            const days = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
            return days[d.getDay()];
        });

        if (window.weeklyChart) {
            window.weeklyChart.destroy();
        }

        window.weeklyChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Giá Trị Nguyên Liệu Xuất (VNĐ)',
                    data: revenueData,
                    borderColor: '#8B4513',
                    backgroundColor: 'rgba(139, 69, 19, 0.1)',
                    tension: 0.4,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            callback: function(value) {
                                return value.toLocaleString('vi-VN') + 'đ';
                            }
                        }
                    }
                }
            }
        });
    }

    // Statistics
    displayStatistics() {
        this.updateRevenueStats();
        this.updateMonthlyRevenueChart();
        this.updateTopProductsChart();
        this.displayProductRevenueTable();
    }

    updateRevenueStats() {
        const today = new Date();
        const todayStr = today.toDateString();
        
        // Today's revenue
        const todayRevenue = this.exports
            .filter(e => new Date(e.date).toDateString() === todayStr)
            .reduce((sum, e) => sum + this.getExportTotal(e), 0);
        document.getElementById('todayRevenue').textContent = this.formatCurrency(todayRevenue);

        // Week's revenue
        const weekAgo = new Date(today);
        weekAgo.setDate(weekAgo.getDate() - 7);
        const weekRevenue = this.exports
            .filter(e => new Date(e.date) >= weekAgo)
            .reduce((sum, e) => sum + this.getExportTotal(e), 0);
        document.getElementById('weekRevenue').textContent = this.formatCurrency(weekRevenue);

        // Month's revenue
        const monthRevenue = this.exports
            .filter(e => {
                const date = new Date(e.date);
                return date.getMonth() === today.getMonth() && date.getFullYear() === today.getFullYear();
            })
            .reduce((sum, e) => sum + this.getExportTotal(e), 0);
        document.getElementById('monthRevenue').textContent = this.formatCurrency(monthRevenue);

        // Estimated profit
        const profit = this.exports.reduce((sum, e) => {
            const exportTotal = this.getExportTotal(e);
            const exportCost = (Number(e.quantity) || 0) * (Number(e.costPrice) || 0);
            return sum + (exportTotal - exportCost);
        }, 0);
        document.getElementById('estimatedProfit').textContent = this.formatCurrency(profit);
    }

    updateMonthlyRevenueChart() {
        const ctx = document.getElementById('monthlyRevenueChart');
        if (!ctx) return;

        const months = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12'];
        const currentYear = new Date().getFullYear();
        
        const revenueData = months.map((_, index) => {
            return this.exports
                .filter(e => {
                    const date = new Date(e.date);
                    return date.getMonth() === index && date.getFullYear() === currentYear;
                })
                .reduce((sum, e) => sum + this.getExportTotal(e), 0);
        });

        if (window.monthlyChart) {
            window.monthlyChart.destroy();
        }

        window.monthlyChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: months,
                datasets: [{
                    label: 'Doanh Thu (VNĐ)',
                    data: revenueData,
                    backgroundColor: '#8B4513',
                    borderRadius: 5
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            callback: function(value) {
                                return (value / 1000) + 'K';
                            }
                        }
                    }
                }
            }
        });
    }

    updateTopProductsChart() {
        const ctx = document.getElementById('topProductsChart');
        if (!ctx) return;

        // Calculate sales by product
        const productSales = {};
        this.exports.forEach(e => {
            if (!productSales[e.productName]) {
                productSales[e.productName] = 0;
            }
            productSales[e.productName] += e.quantity;
        });

        // Sort and get top 5
        const sorted = Object.entries(productSales)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);

        if (window.topProductsChart) {
            window.topProductsChart.destroy();
        }

        window.topProductsChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: sorted.map(s => s[0]),
                datasets: [{
                    data: sorted.map(s => s[1]),
                    backgroundColor: [
                        '#8B4513',
                        '#D2691E',
                        '#CD853F',
                        '#DEB887',
                        '#F4A460'
                    ]
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        position: 'bottom'
                    }
                }
            }
        });
    }

    displayProductRevenueTable() {
        const tbody = document.getElementById('productRevenueTable');
        
        // Calculate stats by product
        const productStats = {};
        this.exports.forEach(e => {
            if (!productStats[e.productId]) {
                productStats[e.productId] = {
                    name: e.productName,
                    quantity: 0,
                    revenue: 0,
                    cost: 0
                };
            }
            productStats[e.productId].quantity += e.quantity;
            productStats[e.productId].revenue += this.getExportTotal(e);
            productStats[e.productId].cost += e.quantity * e.costPrice;
        });

        const statsArray = Object.values(productStats).sort((a, b) => b.revenue - a.revenue);

        tbody.innerHTML = statsArray.map(stat => `
            <tr>
                <td>${stat.name}</td>
                <td>${stat.quantity}</td>
                <td class="text-success"><strong>${this.formatCurrency(stat.revenue)}</strong></td>
                <td class="text-danger">${this.formatCurrency(stat.cost)}</td>
                <td class="text-primary"><strong>${this.formatCurrency(stat.revenue - stat.cost)}</strong></td>
            </tr>
        `).join('');
    }

    // Adjustments Management
    displayAdjustmentsSection() {
        this.populateProductSelect('adjustmentProduct');
        this.setAdjustmentDateDefault();
        this.displayAdjustmentHistory();
    }

    updateAdjustmentInfo() {
        const productId = parseInt(document.getElementById('adjustmentProduct').value);
        if (productId) {
            const product = this.products.find(p => p.id === productId);
            if (product) {
                const displayText = product.conversionUnit && product.conversionRate
                    ? `${product.stock} ${product.unit} (≈ ${(product.stock / product.conversionRate).toFixed(2)} ${product.conversionUnit})`
                    : `${product.stock} ${product.unit}`;
                document.getElementById('adjustmentCurrentStock').textContent = displayText;
            }
        }
    }



    handleAdjustment() {
        const productId = parseInt(document.getElementById('adjustmentProduct').value);
        const type = document.getElementById('adjustmentType').value;
        const quantity = parseFloat(document.getElementById('adjustmentQuantity').value);
        const selectedDate = document.getElementById('adjustmentDate').value || this.getTodayDateValue();
        const reason = document.getElementById('adjustmentReason').value;
        const note = document.getElementById('adjustmentNote').value;

        if (!productId || !quantity || !reason) {
            alert('Vui lòng điền đầy đủ thông tin!');
            return;
        }

        const product = this.products.find(p => p.id === productId);
        if (!product) return;

        const oldStock = product.stock;
        let newStock;

        if (type === 'increase') {
            newStock = oldStock + quantity;
        } else {
            newStock = oldStock - quantity;
            if (newStock < 0) {
                alert('⚠️ Số lượng điều chỉnh không được lớn hơn tồn kho hiện tại!');
                return;
            }
        }

        // Create adjustment record
        const adjustmentRecord = {
            id: Date.now(),
            date: this.buildIsoFromDateInput(selectedDate),
            productId: productId,
            productName: product.name,
            productUnit: product.unit,
            type: type,
            quantity: quantity,
            oldStock: oldStock,
            newStock: newStock,
            reason: reason,
            reasonText: this.getAdjustmentReasonText(reason),
            note: note || '-'
        };

        this.adjustments.push(adjustmentRecord);
        this.saveData('adjustments', this.adjustments);

        // Update product stock
        product.stock = newStock;
        this.saveData('products', this.products);

        const changeText = type === 'increase' ? `+${quantity}` : `-${quantity}`;
        alert(`✅ Điều chỉnh thành công!\n\n${product.name}: ${oldStock} → ${newStock} ${product.unit} (${changeText})`);

        // Reset form
        document.getElementById('adjustmentForm').reset();
        this.setAdjustmentDateDefault(true);
        document.getElementById('adjustmentCurrentStock').textContent = '0';
        this.displayAdjustmentHistory();
        this.updateDashboard();
    }

    getAdjustmentReasonText(reason) {
        const reasons = {
            'damaged': 'Hàng hỏng',
            'lost': 'Mất mát/Thất thoát',
            'expired': 'Hết hạn sử dụng',
            'inventory_check': 'Kiểm kê chênh lệch',
            'correction': 'Sửa sai số liệu',
            'other': 'Lý do khác'
        };
        return reasons[reason] || reason;
    }

    displayAdjustmentHistory() {
        const tbody = document.getElementById('adjustmentHistory');
        const recentAdjustments = this.adjustments.slice(-30).reverse();
        
        tbody.innerHTML = recentAdjustments.map(adj => {
            const typeClass = adj.type === 'increase' ? 'text-success' : 'text-danger';
            const typeIcon = adj.type === 'increase' ? '↑' : '↓';
            const changeText = adj.type === 'increase' ? `+${adj.quantity}` : `-${adj.quantity}`;
            
            return `
                <tr>
                    <td>${this.formatDate(adj.date)}</td>
                    <td>${adj.productName}</td>
                    <td><span class="${typeClass}"><strong>${typeIcon} ${adj.type === 'increase' ? 'Tăng' : 'Giảm'}</strong></span></td>
                    <td class="${typeClass}"><strong>${changeText}</strong> ${adj.productUnit}</td>
                    <td><small>${adj.reasonText}</small></td>
                    <td>
                        <button class="btn btn-sm btn-warning" onclick="app.editAdjustmentDate(${adj.id})" title="Sửa phiếu">
                            <i class="bi bi-pencil"></i>
                        </button>
                        <button class="btn btn-sm btn-danger" onclick="app.deleteAdjustment(${adj.id})" title="Xóa">
                            <i class="bi bi-trash"></i>
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    }

    deleteAdjustment(id) {
        const adjustment = this.adjustments.find(a => a.id === id);
        if (!adjustment) return;

        if (!confirm(`⚠️ Bạn có chắc muốn xóa bản ghi điều chỉnh này?\n\nLưu ý: Tồn kho sẽ được hoàn nguyên!`)) {
            return;
        }

        // Revert stock
        const product = this.products.find(p => p.id === adjustment.productId);
        if (product) {
            if (adjustment.type === 'increase') {
                product.stock -= adjustment.quantity;
                if (product.stock < 0) product.stock = 0;
            } else {
                product.stock += adjustment.quantity;
            }
            this.saveData('products', this.products);
        }

        // Delete adjustment
        this.adjustments = this.adjustments.filter(a => a.id !== id);
        this.saveData('adjustments', this.adjustments);

        this.displayAdjustmentHistory();
        this.updateDashboard();

        alert('✅ Đã xóa và hoàn nguyên tồn kho thành công!');
    }

    editAdjustmentDate(id) {
        const adjustment = this.adjustments.find(a => a.id === id);
        if (!adjustment) {
            alert('❌ Không tìm thấy bản ghi điều chỉnh!');
            return;
        }

        // Set edit mode
        document.getElementById('adjustmentMode').value = 'edit';
        document.getElementById('editAdjustmentId').value = adjustment.id;
        
        // Populate form fields
        this.populateProductSelect('adjustmentProduct');
        document.getElementById('adjustmentProduct').value = adjustment.productId;
        document.getElementById('adjustmentType').value = adjustment.type;
        document.getElementById('adjustmentQuantity').value = adjustment.quantity;
        document.getElementById('adjustmentReason').value = adjustment.reason || 'other';
        document.getElementById('adjustmentDate').value = this.toDateInputValue(adjustment.date);
        document.getElementById('adjustmentNote').value = adjustment.note && adjustment.note !== '-' ? adjustment.note : '';

        // Update stock display and title
        this.updateAdjustmentInfo();
        document.getElementById('adjustmentFormTitle').textContent = 'Chỉnh Sửa Phiếu Điều Chỉnh';
        document.getElementById('submitBtnText').textContent = 'Cập Nhật Phiếu';
        document.getElementById('adjustmentCancelBtn').style.display = 'block';
        
        // Scroll to form
        document.getElementById('adjustmentForm').scrollIntoView({ behavior: 'smooth' });
    }

    cancelAdjustmentEdit() {
        // Reset mode
        document.getElementById('adjustmentMode').value = 'create';
        document.getElementById('editAdjustmentId').value = '';
        
        // Reset form
        document.getElementById('adjustmentForm').reset();
        this.setAdjustmentDateDefault(true);
        document.getElementById('adjustmentCurrentStock').textContent = '0';
        
        // Reset UI
        document.getElementById('adjustmentFormTitle').textContent = 'Phiếu Điều Chỉnh Kho';
        document.getElementById('submitBtnText').textContent = 'Xác Nhận Điều Chỉnh';
        document.getElementById('adjustmentCancelBtn').style.display = 'none';
    }

    saveAdjustmentEdit() {
        const id = parseInt(document.getElementById('editAdjustmentId').value, 10);
        const productId = parseInt(document.getElementById('adjustmentProduct').value, 10);
        const type = document.getElementById('adjustmentType').value;
        const quantity = parseFloat(document.getElementById('adjustmentQuantity').value);
        const reason = document.getElementById('adjustmentReason').value;
        const selectedDate = document.getElementById('adjustmentDate').value || this.getTodayDateValue();
        const note = document.getElementById('adjustmentNote').value;

        if (!id || !productId || !type || !quantity || !reason || !selectedDate) {
            alert('⚠️ Vui lòng điền đầy đủ thông tin phiếu điều chỉnh!');
            return;
        }

        const index = this.adjustments.findIndex(a => a.id === id);
        if (index === -1) {
            alert('❌ Không tìm thấy bản ghi điều chỉnh!');
            return;
        }

        const existing = this.adjustments[index];
        const isoDate = this.buildIsoFromDateInput(selectedDate, existing.date);
        if (Number.isNaN(new Date(isoDate).getTime())) {
            alert('❌ Ngày điều chỉnh không hợp lệ!');
            return;
        }

        const previousProduct = this.products.find(p => p.id === existing.productId);
        const targetProduct = this.products.find(p => p.id === productId);

        if (!previousProduct || !targetProduct) {
            alert('❌ Không tìm thấy nguyên liệu để cập nhật phiếu điều chỉnh!');
            return;
        }

        // Hoàn tác ảnh hưởng cũ của phiếu điều chỉnh hiện tại
        if (existing.type === 'increase') {
            previousProduct.stock -= existing.quantity;
        } else {
            previousProduct.stock += existing.quantity;
        }

        const oldStockBeforeEdit = targetProduct.stock;
        let newStockAfterEdit;

        if (type === 'increase') {
            newStockAfterEdit = oldStockBeforeEdit + quantity;
        } else {
            newStockAfterEdit = oldStockBeforeEdit - quantity;
            if (newStockAfterEdit < 0) {
                // Khôi phục lại ảnh hưởng cũ nếu dữ liệu mới không hợp lệ
                if (existing.type === 'increase') {
                    previousProduct.stock += existing.quantity;
                } else {
                    previousProduct.stock -= existing.quantity;
                }

                alert(`⚠️ Không đủ tồn kho để giảm!

Tồn kho hiện có: ${oldStockBeforeEdit} ${targetProduct.unit}
Số lượng điều chỉnh: ${quantity} ${targetProduct.unit}`);
                return;
            }
        }

        targetProduct.stock = newStockAfterEdit;

        this.adjustments[index] = {
            ...existing,
            productId,
            productName: targetProduct.name,
            productUnit: targetProduct.unit,
            type,
            quantity,
            oldStock: oldStockBeforeEdit,
            newStock: newStockAfterEdit,
            reason,
            reasonText: this.getAdjustmentReasonText(reason),
            date: isoDate,
            note: note.trim() ? note.trim() : '-'
        };

        this.saveData('products', this.products);
        this.saveData('adjustments', this.adjustments);
        
        alert('✅ Cập nhật phiếu điều chỉnh thành công!');
        
        this.displayAdjustmentHistory();
        this.updateAdjustmentInfo();
        this.updateDashboard();
        this.cancelAdjustmentEdit();

        const modal = bootstrap.Modal.getInstance(document.getElementById('adjustmentEditModal'));
        if (modal) modal.hide();

        alert('✅ Đã cập nhật phiếu điều chỉnh!');
    }

    // Utility Functions
    getExportTotal(exportRecord) {
        const totalCost = Number(exportRecord?.totalCost);
        if (Number.isFinite(totalCost)) return totalCost;

        const total = Number(exportRecord?.total);
        if (Number.isFinite(total)) return total;

        return (Number(exportRecord?.quantity) || 0) * (Number(exportRecord?.costPrice) || 0);
    }

    formatCurrency(amount) {
        return new Intl.NumberFormat('vi-VN', {
            style: 'currency',
            currency: 'VND'
        }).format(amount);
    }

    formatDate(dateString) {
        const date = new Date(dateString);
        return date.toLocaleString('vi-VN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    // Generate Product Code
    generateProductCode() {
        // Tìm mã lớn nhất hiện tại
        let maxNumber = 0;
        this.products.forEach(p => {
            const match = p.code.match(/NL(\d+)/);
            if (match) {
                const num = parseInt(match[1]);
                if (num > maxNumber) maxNumber = num;
            }
        });
        
        // Tạo mã mới
        const nextNumber = maxNumber + 1;
        return 'NL' + String(nextNumber).padStart(3, '0'); // NL001, NL002, ...
    }

    // Data Export/Import Functions
    exportData() {
        const data = {
            products: this.products,
            imports: this.imports,
            exports: this.exports,
            adjustments: this.adjustments,
            monthlySnapshots: this.monthlySnapshots,
            revenueTransactions: this.revenueTransactions,
            exportDate: new Date().toISOString(),
            version: '1.0.0'
        };

        const jsonString = JSON.stringify(data, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const link = document.createElement('a');
        link.href = url;
        link.download = `kho-tra-sua-backup-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        alert('✅ Đã xuất dữ liệu thành công!\nFile được lưu vào thư mục Downloads.');
    }

    // Quick Backup (nút trên menu)
    quickBackup() {
        this.exportData();
    }

    // Auto Download Backup
    autoDownloadBackup() {
        const data = {
            products: this.products,
            imports: this.imports,
            exports: this.exports,
            adjustments: this.adjustments,
            monthlySnapshots: this.monthlySnapshots,
            revenueTransactions: this.revenueTransactions,
            exportDate: new Date().toISOString(),
            version: '1.0.0',
            autoBackup: true
        };

        const jsonString = JSON.stringify(data, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const link = document.createElement('a');
        link.href = url;
        const timestamp = new Date().toISOString().split('T')[0];
        link.download = `auto-backup-${timestamp}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        console.log('✅ Auto backup file downloaded:', `auto-backup-${timestamp}.json`);
        
        // Hiển thị thông báo nhẹ không gây phiền
        const indicator = document.getElementById('autoSaveIndicator');
        if (indicator) {
            indicator.innerHTML = '<i class="bi bi-download"></i> Backup tự động';
            indicator.style.opacity = '1';
            setTimeout(() => {
                indicator.style.opacity = '0';
            }, 3000);
        }
    }

    // Daily report on web
    showDailyReport() {
        const selectedDateValue = document.getElementById('dailyReportDate')?.value || this.getTodayDateValue();
        const selectedDate = new Date(`${selectedDateValue}T00:00:00`);

        if (Number.isNaN(selectedDate.getTime())) {
            alert('❌ Ngày báo cáo không hợp lệ!');
            return;
        }

        const displayDate = selectedDate.toLocaleDateString('vi-VN', { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
        });
        
        // Lọc giao dịch theo ngày được chọn và bổ sung thông tin sản phẩm
        const dayImports = this.imports.filter(imp => this.isSameDate(imp.date, selectedDate)).map(imp => {
            const product = this.products.find(p => p.id === imp.productId);
            return {
                ...imp,
                productName: imp.productName || (product ? product.name : 'N/A'),
                productUnit: imp.productUnit || (product ? product.unit : ''),
                price: imp.price || 0,
                total: imp.total || (imp.quantity * imp.price)
            };
        });
        
        const dayExports = this.exports.filter(exp => this.isSameDate(exp.date, selectedDate)).map(exp => {
            const product = this.products.find(p => p.id === exp.productId);
            return {
                ...exp,
                productName: exp.productName || (product ? product.name : 'N/A'),
                productUnit: exp.productUnit || (product ? product.unit : ''),
                price: exp.price || 0,
                totalCost: exp.totalCost || 0
            };
        });
        
        const dayAdjustments = this.adjustments.filter(adj => this.isSameDate(adj.date, selectedDate));
        
        // Tính tổng giá trị
        const totalImportValue = dayImports.reduce((sum, imp) => sum + (imp.total || 0), 0);
        const totalExportCost = dayExports.reduce((sum, exp) => sum + (exp.totalCost || 0), 0);
        
        // Tạo báo cáo
        const report = {
            reportType: 'DAILY',
            reportDate: selectedDateValue,
            reportDateDisplay: displayDate,
            createdAt: new Date().toISOString(),
            summary: {
                totalImports: dayImports.length,
                totalExports: dayExports.length,
                totalAdjustments: dayAdjustments.length,
                totalImportValue: totalImportValue,
                totalExportCost: totalExportCost,
                currentInventoryValue: this.products.reduce((sum, p) => sum + (p.stock * p.costPrice), 0)
            },
            imports: dayImports,
            exports: dayExports,
            adjustments: dayAdjustments,
            currentInventory: JSON.parse(JSON.stringify(this.products)),
            lowStockItems: this.products.filter(p => p.stock <= p.minStock && p.stock > 0),
            outOfStockItems: this.products.filter(p => p.stock === 0)
        };

        this.displayDailyReportModal(report);
    }

    // Monthly report on web
    showMonthlyReport() {
        const monthValue = document.getElementById('monthlyReportMonth')?.value || this.getCurrentMonthValue();
        const [yearText, monthText] = monthValue.split('-');
        const year = parseInt(yearText, 10);
        const monthIndex = parseInt(monthText, 10) - 1;

        if (Number.isNaN(year) || Number.isNaN(monthIndex) || monthIndex < 0 || monthIndex > 11) {
            alert('❌ Tháng báo cáo không hợp lệ!');
            return;
        }

        const targetMonthDate = new Date(year, monthIndex, 1);
        const month = monthIndex + 1;
        const monthName = targetMonthDate.toLocaleDateString('vi-VN', { month: 'long', year: 'numeric' });
        
        // Tính khoảng thời gian tháng được chọn
        const startOfMonth = new Date(year, monthIndex, 1);
        const endOfMonth = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
        
        // Lọc giao dịch trong tháng và bổ sung thông tin sản phẩm
        const monthImports = this.imports.filter(imp => {
            const impDate = new Date(imp.date);
            return impDate >= startOfMonth && impDate <= endOfMonth;
        }).map(imp => {
            const product = this.products.find(p => p.id === imp.productId);
            return {
                ...imp,
                productName: imp.productName || (product ? product.name : 'N/A'),
                productUnit: imp.productUnit || (product ? product.unit : ''),
                price: imp.price || 0,
                total: imp.total || (imp.quantity * imp.price)
            };
        });
        
        const monthExports = this.exports.filter(exp => {
            const expDate = new Date(exp.date);
            return expDate >= startOfMonth && expDate <= endOfMonth;
        }).map(exp => {
            const product = this.products.find(p => p.id === exp.productId);
            return {
                ...exp,
                productName: exp.productName || (product ? product.name : 'N/A'),
                productUnit: exp.productUnit || (product ? product.unit : ''),
                price: exp.price || 0,
                totalCost: exp.totalCost || 0
            };
        });
        
        const monthAdjustments = this.adjustments.filter(adj => {
            const adjDate = new Date(adj.date);
            return adjDate >= startOfMonth && adjDate <= endOfMonth;
        });
        
        // Tính tổng giá trị
        const totalImportValue = monthImports.reduce((sum, imp) => sum + (imp.total || 0), 0);
        const totalExportCost = monthExports.reduce((sum, exp) => sum + (exp.totalCost || 0), 0);
        
        // Thống kê theo sản phẩm
        const productStats = {};
        this.products.forEach(product => {
            const productImports = monthImports.filter(imp => imp.productId === product.id);
            const productExports = monthExports.filter(exp => exp.productId === product.id);
            
            productStats[product.id] = {
                product: product,
                totalImported: productImports.reduce((sum, imp) => sum + imp.quantity, 0),
                totalExported: productExports.reduce((sum, exp) => sum + exp.quantity, 0),
                importValue: productImports.reduce((sum, imp) => sum + (imp.total || 0), 0),
                exportCost: productExports.reduce((sum, exp) => sum + (exp.totalCost || 0), 0),
                currentStock: product.stock
            };
        });
        
        // Tạo báo cáo
        const report = {
            reportType: 'MONTHLY',
            year: year,
            month: month,
            monthName: monthName,
            period: {
                start: startOfMonth.toISOString(),
                end: endOfMonth.toISOString()
            },
            createdAt: new Date().toISOString(),
            summary: {
                totalProducts: this.products.length,
                totalImports: monthImports.length,
                totalExports: monthExports.length,
                totalAdjustments: monthAdjustments.length,
                totalImportValue: totalImportValue,
                totalExportCost: totalExportCost,
                currentInventoryValue: this.products.reduce((sum, p) => sum + (p.stock * p.costPrice), 0),
                lowStockItems: this.products.filter(p => p.stock <= p.minStock && p.stock > 0).length,
                outOfStockItems: this.products.filter(p => p.stock === 0).length
            },
            productStatistics: productStats,
            imports: monthImports,
            exports: monthExports,
            adjustments: monthAdjustments,
            currentInventory: JSON.parse(JSON.stringify(this.products))
        };

        this.displayMonthlyReportModal(report);
    }

    showYearlyReport() {
        const yearValue = document.getElementById('yearlyReportYear')?.value || this.getCurrentYearValue();
        const year = parseInt(yearValue, 10);

        if (Number.isNaN(year) || year < 2000 || year > 2100) {
            alert('❌ Năm báo cáo không hợp lệ!');
            return;
        }

        // Tính khoảng thời gian năm được chọn
        const startOfYear = new Date(year, 0, 1);
        const endOfYear = new Date(year, 11, 31, 23, 59, 59, 999);
        
        // Lọc giao dịch trong năm và bổ sung thông tin sản phẩm
        const yearImports = this.imports.filter(imp => {
            const impDate = new Date(imp.date);
            return impDate >= startOfYear && impDate <= endOfYear;
        }).map(imp => {
            const product = this.products.find(p => p.id === imp.productId);
            return {
                ...imp,
                productName: imp.productName || (product ? product.name : 'N/A'),
                productUnit: imp.productUnit || (product ? product.unit : ''),
                price: imp.price || 0,
                total: imp.total || (imp.quantity * imp.price)
            };
        });
        
        const yearExports = this.exports.filter(exp => {
            const expDate = new Date(exp.date);
            return expDate >= startOfYear && expDate <= endOfYear;
        }).map(exp => {
            const product = this.products.find(p => p.id === exp.productId);
            return {
                ...exp,
                productName: exp.productName || (product ? product.name : 'N/A'),
                productUnit: exp.productUnit || (product ? product.unit : ''),
                price: exp.price || 0,
                totalCost: exp.totalCost || 0
            };
        });
        
        const yearAdjustments = this.adjustments.filter(adj => {
            const adjDate = new Date(adj.date);
            return adjDate >= startOfYear && adjDate <= endOfYear;
        });
        
        // Tính tổng giá trị
        const totalImportValue = yearImports.reduce((sum, imp) => sum + (imp.total || 0), 0);
        const totalExportCost = yearExports.reduce((sum, exp) => sum + (exp.totalCost || 0), 0);
        
        // Thống kê theo sản phẩm
        const productStats = {};
        this.products.forEach(product => {
            const productImports = yearImports.filter(imp => imp.productId === product.id);
            const productExports = yearExports.filter(exp => exp.productId === product.id);
            
            productStats[product.id] = {
                product: product,
                totalImported: productImports.reduce((sum, imp) => sum + imp.quantity, 0),
                totalExported: productExports.reduce((sum, exp) => sum + exp.quantity, 0),
                importValue: productImports.reduce((sum, imp) => sum + (imp.total || 0), 0),
                exportCost: productExports.reduce((sum, exp) => sum + (exp.totalCost || 0), 0),
                currentStock: product.stock
            };
        });
        
        // Tạo báo cáo
        const report = {
            reportType: 'YEARLY',
            year: year,
            yearName: `Năm ${year}`,
            period: {
                start: startOfYear.toISOString(),
                end: endOfYear.toISOString()
            },
            createdAt: new Date().toISOString(),
            summary: {
                totalProducts: this.products.length,
                totalImports: yearImports.length,
                totalExports: yearExports.length,
                totalAdjustments: yearAdjustments.length,
                totalImportValue: totalImportValue,
                totalExportCost: totalExportCost,
                currentInventoryValue: this.products.reduce((sum, p) => sum + (p.stock * p.costPrice), 0),
                lowStockItems: this.products.filter(p => p.stock <= p.minStock && p.stock > 0).length,
                outOfStockItems: this.products.filter(p => p.stock === 0).length
            },
            productStatistics: productStats,
            imports: yearImports,
            exports: yearExports,
            adjustments: yearAdjustments,
            currentInventory: JSON.parse(JSON.stringify(this.products))
        };

        this.displayMonthlyReportModal(report);
    }

    // Compatibility wrappers for old button handlers
    exportDailyReport() {
        this.showDailyReport();
    }

    exportMonthlyReport() {
        this.showMonthlyReport();
    }

    createMonthlySnapshot() {
        const snapshot = MonthlyReportManager.createSnapshot();
        
        // Kiểm tra xem đã có báo cáo tháng này chưa
        const existingIndex = this.monthlySnapshots.findIndex(s => s.monthYear === snapshot.monthYear);
        
        if (existingIndex >= 0) {
            if (!confirm(`⚠️ Đã có báo cáo cho tháng ${snapshot.monthName}.\n\nBạn có muốn ghi đè báo cáo cũ không?`)) {
                return;
            }
            this.monthlySnapshots[existingIndex] = snapshot;
        } else {
            this.monthlySnapshots.push(snapshot);
        }
        
        // Sắp xếp theo thời gian mới nhất
        this.monthlySnapshots.sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
        
        this.saveData('monthlySnapshots', this.monthlySnapshots);
        this.displayMonthlyReports();
        
        alert(`✅ Đã tạo báo cáo tháng ${snapshot.monthName} thành công!`);
    }

    // View exported report file
    viewReportFile(event) {
        const file = event.target.files[0];
        if (!file) return;

        if (!file.name.endsWith('.json')) {
            alert('❌ Vui lòng chọn file JSON báo cáo!');
            event.target.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const report = JSON.parse(e.target.result);
                
                // Kiểm tra loại báo cáo
                if (!report.reportType) {
                    alert('❌ File không phải là file báo cáo hợp lệ!');
                    event.target.value = '';
                    return;
                }
                
                if (report.reportType === 'DAILY') {
                    this.displayDailyReportModal(report);
                } else if (report.reportType === 'MONTHLY') {
                    this.displayMonthlyReportModal(report);
                } else {
                    alert('❌ Loại báo cáo không được hỗ trợ!');
                }
                
                event.target.value = '';
            } catch (error) {
                alert('❌ Lỗi đọc file báo cáo: ' + error.message);
                event.target.value = '';
            }
        };
        
        reader.readAsText(file);
    }

    displayDailyReportModal(report) {
        const modalContent = `
            <div class="modal fade" id="viewReportModal" tabindex="-1">
                <div class="modal-dialog modal-xl">
                    <div class="modal-content">
                        <div class="modal-header bg-success text-white">
                            <h5 class="modal-title">
                                <i class="bi bi-file-earmark-spreadsheet"></i> 
                                Báo Cáo Ngày: ${report.reportDateDisplay}
                            </h5>
                            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body">
                            <!-- Tóm tắt -->
                            <div class="row mb-4">
                                <div class="col-md-3">
                                    <div class="card border-success">
                                        <div class="card-body text-center">
                                            <i class="bi bi-arrow-down-circle fs-3 text-success"></i>
                                            <h4 class="mt-2">${report.summary.totalImports}</h4>
                                            <small class="text-muted">Phiếu nhập</small>
                                            <p class="mb-0 mt-1"><strong>${this.formatCurrency(report.summary.totalImportValue)}</strong></p>
                                        </div>
                                    </div>
                                </div>
                                <div class="col-md-3">
                                    <div class="card border-warning">
                                        <div class="card-body text-center">
                                            <i class="bi bi-arrow-up-circle fs-3 text-warning"></i>
                                            <h4 class="mt-2">${report.summary.totalExports}</h4>
                                            <small class="text-muted">Phiếu xuất</small>
                                            <p class="mb-0 mt-1"><strong>${this.formatCurrency(report.summary.totalExportCost)}</strong></p>
                                        </div>
                                    </div>
                                </div>
                                <div class="col-md-3">
                                    <div class="card border-info">
                                        <div class="card-body text-center">
                                            <i class="bi bi-sliders fs-3 text-info"></i>
                                            <h4 class="mt-2">${report.summary.totalAdjustments}</h4>
                                            <small class="text-muted">Điều chỉnh</small>
                                        </div>
                                    </div>
                                </div>
                                <div class="col-md-3">
                                    <div class="card border-primary">
                                        <div class="card-body text-center">
                                            <i class="bi bi-cash-stack fs-3 text-primary"></i>
                                            <h5 class="mt-2">${this.formatCurrency(report.summary.currentInventoryValue)}</h5>
                                            <small class="text-muted">Giá trị tồn kho hiện tại</small>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <!-- Tabs -->
                            <ul class="nav nav-tabs" role="tablist">
                                <li class="nav-item">
                                    <button class="nav-link active" data-bs-toggle="tab" data-bs-target="#importsTab">
                                        <i class="bi bi-arrow-down-circle"></i> Phiếu Nhập (${report.imports.length})
                                    </button>
                                </li>
                                <li class="nav-item">
                                    <button class="nav-link" data-bs-toggle="tab" data-bs-target="#exportsTab">
                                        <i class="bi bi-arrow-up-circle"></i> Phiếu Xuất (${report.exports.length})
                                    </button>
                                </li>
                                <li class="nav-item">
                                    <button class="nav-link" data-bs-toggle="tab" data-bs-target="#inventoryTab">
                                        <i class="bi bi-boxes"></i> Tồn Kho Hiện Tại
                                    </button>
                                </li>
                                <li class="nav-item">
                                    <button class="nav-link" data-bs-toggle="tab" data-bs-target="#alertsTab">
                                        <i class="bi bi-exclamation-triangle"></i> Cảnh Báo
                                    </button>
                                </li>
                            </ul>

                            <div class="tab-content mt-3">
                                <!-- Phiếu nhập -->
                                <div class="tab-pane fade show active" id="importsTab">
                                    ${report.imports.length > 0 ? `
                                        <div class="table-responsive" style="max-height: 400px; overflow-y: auto;">
                                            <table class="table table-striped table-sm">
                                                <thead class="sticky-top bg-white">
                                                    <tr>
                                                        <th>Thời gian</th>
                                                        <th>Sản phẩm</th>
                                                        <th>Số lượng</th>
                                                        <th>Giá nhập</th>
                                                        <th>Tổng tiền</th>
                                                        <th>NCC</th>
                                                        <th>Ghi chú</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    ${report.imports.map(imp => `
                                                        <tr>
                                                            <td>${new Date(imp.date).toLocaleTimeString('vi-VN')}</td>
                                                            <td>${imp.productName}</td>
                                                            <td><strong>${imp.quantity}</strong> ${imp.productUnit}</td>
                                                            <td>${this.formatCurrency(imp.price)}</td>
                                                            <td><strong>${this.formatCurrency(imp.total)}</strong></td>
                                                            <td>${imp.supplier}</td>
                                                            <td>${imp.note || '-'}</td>
                                                        </tr>
                                                    `).join('')}
                                                </tbody>
                                            </table>
                                        </div>
                                    ` : '<p class="text-muted text-center py-4">Không có phiếu nhập nào trong ngày này</p>'}
                                </div>

                                <!-- Phiếu xuất -->
                                <div class="tab-pane fade" id="exportsTab">
                                    ${report.exports.length > 0 ? `
                                        <div class="table-responsive" style="max-height: 400px; overflow-y: auto;">
                                            <table class="table table-striped table-sm">
                                                <thead class="sticky-top bg-white">
                                                    <tr>
                                                        <th>Thời gian</th>
                                                        <th>Sản phẩm</th>
                                                        <th>Số lượng</th>
                                                        <th>Giá xuất</th>
                                                        <th>Giá vốn</th>
                                                        <th>Mục đích</th>
                                                        <th>Ghi chú</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    ${report.exports.map(exp => `
                                                        <tr>
                                                            <td>${new Date(exp.date).toLocaleTimeString('vi-VN')}</td>
                                                            <td>${exp.productName}</td>
                                                            <td><strong>${exp.quantity}</strong> ${exp.productUnit}</td>
                                                            <td>${this.formatCurrency(exp.price)}</td>
                                                            <td>${this.formatCurrency(exp.totalCost || 0)}</td>
                                                            <td>${exp.purpose}</td>
                                                            <td>${exp.note || '-'}</td>
                                                        </tr>
                                                    `).join('')}
                                                </tbody>
                                            </table>
                                        </div>
                                    ` : '<p class="text-muted text-center py-4">Không có phiếu xuất nào trong ngày này</p>'}
                                </div>

                                <!-- Tồn kho hiện tại -->
                                <div class="tab-pane fade" id="inventoryTab">
                                    <div class="table-responsive" style="max-height: 400px; overflow-y: auto;">
                                        <table class="table table-striped table-sm">
                                            <thead class="sticky-top bg-white">
                                                <tr>
                                                    <th>Mã</th>
                                                    <th>Tên sản phẩm</th>
                                                    <th>Tồn kho hiện tại</th>
                                                    <th>Giá vốn</th>
                                                    <th>Giá trị</th>
                                                    <th>Trạng thái</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                ${report.currentInventory.map(product => {
                                                    const stockValue = product.stock * product.costPrice;
                                                    let status, statusClass;
                                                    if (product.stock === 0) {
                                                        status = 'Hết hàng';
                                                        statusClass = 'bg-danger';
                                                    } else if (product.stock <= product.minStock) {
                                                        status = 'Sắp hết';
                                                        statusClass = 'bg-warning';
                                                    } else {
                                                        status = 'Đủ hàng';
                                                        statusClass = 'bg-success';
                                                    }
                                                    return `
                                                        <tr>
                                                            <td>${product.code}</td>
                                                            <td>${product.name}</td>
                                                            <td><strong>${product.stock}</strong> ${product.unit}</td>
                                                            <td>${this.formatCurrency(product.costPrice)}</td>
                                                            <td><strong>${this.formatCurrency(stockValue)}</strong></td>
                                                            <td><span class="badge ${statusClass}">${status}</span></td>
                                                        </tr>
                                                    `;
                                                }).join('')}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>

                                <!-- Cảnh báo -->
                                <div class="tab-pane fade" id="alertsTab">
                                    ${report.lowStockItems.length > 0 || report.outOfStockItems.length > 0 ? `
                                        ${report.outOfStockItems.length > 0 ? `
                                            <h6 class="text-danger"><i class="bi bi-x-circle"></i> Hết Hàng (${report.outOfStockItems.length})</h6>
                                            <div class="mb-3">
                                                ${report.outOfStockItems.map(p => `
                                                    <div class="alert alert-danger">
                                                        <strong>${p.code} - ${p.name}</strong>: Đã hết hàng hoàn toàn
                                                    </div>
                                                `).join('')}
                                            </div>
                                        ` : ''}
                                        
                                        ${report.lowStockItems.length > 0 ? `
                                            <h6 class="text-warning"><i class="bi bi-exclamation-triangle"></i> Sắp Hết (${report.lowStockItems.length})</h6>
                                            <div>
                                                ${report.lowStockItems.map(p => `
                                                    <div class="alert alert-warning">
                                                        <strong>${p.code} - ${p.name}</strong>: Còn ${p.stock} ${p.unit} (tối thiểu: ${p.minStock})
                                                    </div>
                                                `).join('')}
                                            </div>
                                        ` : ''}
                                    ` : '<p class="text-success text-center py-4"><i class="bi bi-check-circle"></i> Không có cảnh báo nào</p>'}
                                </div>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        this.showReportModal(modalContent);
    }

    displayMonthlyReportModal(report) {
        const isYearlyReport = report.reportType === 'YEARLY';
        const reportTitle = isYearlyReport ? `Báo Cáo Năm: ${report.yearName}` : `Báo Cáo Tháng: ${report.monthName}`;
        const headerIcon = isYearlyReport ? 'bi-calendar-year' : 'bi-file-earmark-bar-graph';
        const modalContent = `
            <div class="modal fade" id="viewReportModal" tabindex="-1">
                <div class="modal-dialog modal-xl">
                    <div class="modal-content">
                        <div class="modal-header bg-info text-white">
                            <h5 class="modal-title">
                                <i class="bi ${headerIcon}"></i> 
                                ${reportTitle}
                            </h5>
                            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body">
                            <!-- Tóm tắt -->
                            <div class="row mb-4">
                                <div class="col-md-2">
                                    <div class="card border-secondary">
                                        <div class="card-body text-center p-2">
                                            <i class="bi bi-box-seam fs-4"></i>
                                            <h5 class="mt-1 mb-0">${report.summary.totalProducts}</h5>
                                            <small class="text-muted">Sản phẩm</small>
                                        </div>
                                    </div>
                                </div>
                                <div class="col-md-2">
                                    <div class="card border-success">
                                        <div class="card-body text-center p-2">
                                            <i class="bi bi-arrow-down-circle fs-4 text-success"></i>
                                            <h5 class="mt-1 mb-0">${report.summary.totalImports}</h5>
                                            <small class="text-muted">Phiếu nhập</small>
                                        </div>
                                    </div>
                                </div>
                                <div class="col-md-2">
                                    <div class="card border-warning">
                                        <div class="card-body text-center p-2">
                                            <i class="bi bi-arrow-up-circle fs-4 text-warning"></i>
                                            <h5 class="mt-1 mb-0">${report.summary.totalExports}</h5>
                                            <small class="text-muted">Phiếu xuất</small>
                                        </div>
                                    </div>
                                </div>
                                <div class="col-md-2">
                                    <div class="card border-success">
                                        <div class="card-body text-center p-2">
                                            <h6 class="mt-1 mb-0">${this.formatCurrency(report.summary.totalImportValue)}</h6>
                                            <small class="text-muted">Giá trị nhập</small>
                                        </div>
                                    </div>
                                </div>
                                <div class="col-md-2">
                                    <div class="card border-warning">
                                        <div class="card-body text-center p-2">
                                            <h6 class="mt-1 mb-0">${this.formatCurrency(report.summary.totalExportCost)}</h6>
                                            <small class="text-muted">Giá vốn xuất</small>
                                        </div>
                                    </div>
                                </div>
                                <div class="col-md-2">
                                    <div class="card border-primary">
                                        <div class="card-body text-center p-2">
                                            <h6 class="mt-1 mb-0">${this.formatCurrency(report.summary.currentInventoryValue)}</h6>
                                            <small class="text-muted">Tồn kho hiện tại</small>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <!-- Tabs -->
                            <ul class="nav nav-tabs" role="tablist">
                                <li class="nav-item">
                                    <button class="nav-link active" data-bs-toggle="tab" data-bs-target="#productStatsTab">
                                        <i class="bi bi-graph-up"></i> Thống Kê Sản Phẩm
                                    </button>
                                </li>
                                <li class="nav-item">
                                    <button class="nav-link" data-bs-toggle="tab" data-bs-target="#importsTabM">
                                        <i class="bi bi-arrow-down-circle"></i> Phiếu Nhập (${report.imports.length})
                                    </button>
                                </li>
                                <li class="nav-item">
                                    <button class="nav-link" data-bs-toggle="tab" data-bs-target="#exportsTabM">
                                        <i class="bi bi-arrow-up-circle"></i> Phiếu Xuất (${report.exports.length})
                                    </button>
                                </li>
                                <li class="nav-item">
                                    <button class="nav-link" data-bs-toggle="tab" data-bs-target="#inventoryTabM">
                                        <i class="bi bi-boxes"></i> Tồn Kho Hiện Tại
                                    </button>
                                </li>
                            </ul>

                            <div class="tab-content mt-3">
                                <!-- Thống kê sản phẩm -->
                                <div class="tab-pane fade show active" id="productStatsTab">
                                    <div class="table-responsive" style="max-height: 400px; overflow-y: auto;">
                                        <table class="table table-striped table-sm">
                                            <thead class="sticky-top bg-white">
                                                <tr>
                                                    <th>Sản phẩm</th>
                                                    <th>Tổng nhập</th>
                                                    <th>Giá trị nhập</th>
                                                    <th>Tổng xuất</th>
                                                    <th>Giá vốn xuất</th>
                                                    <th>Tồn cuối kỳ</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                ${Object.values(report.productStatistics).map(stat => `
                                                    <tr>
                                                        <td><strong>${stat.product.code}</strong> - ${stat.product.name}</td>
                                                        <td>${stat.totalImported} ${stat.product.unit}</td>
                                                        <td>${this.formatCurrency(stat.importValue)}</td>
                                                        <td>${stat.totalExported} ${stat.product.unit}</td>
                                                        <td>${this.formatCurrency(stat.exportCost)}</td>
                                                        <td><strong>${stat.currentStock}</strong> ${stat.product.unit}</td>
                                                    </tr>
                                                `).join('')}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>

                                <!-- Phiếu nhập -->
                                <div class="tab-pane fade" id="importsTabM">
                                    ${report.imports.length > 0 ? `
                                        <div class="table-responsive" style="max-height: 400px; overflow-y: auto;">
                                            <table class="table table-striped table-sm">
                                                <thead class="sticky-top bg-white">
                                                    <tr>
                                                        <th>Ngày</th>
                                                        <th>Sản phẩm</th>
                                                        <th>Số lượng</th>
                                                        <th>Giá</th>
                                                        <th>Tổng</th>
                                                        <th>NCC</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    ${report.imports.map(imp => `
                                                        <tr>
                                                            <td>${new Date(imp.date).toLocaleDateString('vi-VN')}</td>
                                                            <td>${imp.productName}</td>
                                                            <td>${imp.quantity} ${imp.productUnit}</td>
                                                            <td>${this.formatCurrency(imp.price)}</td>
                                                            <td><strong>${this.formatCurrency(imp.total)}</strong></td>
                                                            <td>${imp.supplier}</td>
                                                        </tr>
                                                    `).join('')}
                                                </tbody>
                                            </table>
                                        </div>
                                    ` : '<p class="text-muted text-center py-4">Không có phiếu nhập</p>'}
                                </div>

                                <!-- Phiếu xuất -->
                                <div class="tab-pane fade" id="exportsTabM">
                                    ${report.exports.length > 0 ? `
                                        <div class="table-responsive" style="max-height: 400px; overflow-y: auto;">
                                            <table class="table table-striped table-sm">
                                                <thead class="sticky-top bg-white">
                                                    <tr>
                                                        <th>Ngày</th>
                                                        <th>Sản phẩm</th>
                                                        <th>Số lượng</th>
                                                        <th>Giá xuất</th>
                                                        <th>Giá vốn</th>
                                                        <th>Mục đích</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    ${report.exports.map(exp => `
                                                        <tr>
                                                            <td>${new Date(exp.date).toLocaleDateString('vi-VN')}</td>
                                                            <td>${exp.productName}</td>
                                                            <td>${exp.quantity} ${exp.productUnit}</td>
                                                            <td>${this.formatCurrency(exp.price)}</td>
                                                            <td>${this.formatCurrency(exp.totalCost || 0)}</td>
                                                            <td>${exp.purpose}</td>
                                                        </tr>
                                                    `).join('')}
                                                </tbody>
                                            </table>
                                        </div>
                                    ` : '<p class="text-muted text-center py-4">Không có phiếu xuất</p>'}
                                </div>

                                <!-- Tồn kho hiện tại -->
                                <div class="tab-pane fade" id="inventoryTabM">
                                    <div class="table-responsive" style="max-height: 400px; overflow-y: auto;">
                                        <table class="table table-striped table-sm">
                                            <thead class="sticky-top bg-white">
                                                <tr>
                                                    <th>Mã</th>
                                                    <th>Tên sản phẩm</th>
                                                    <th>Tồn kho hiện tại</th>
                                                    <th>Giá vốn</th>
                                                    <th>Giá trị</th>
                                                    <th>Trạng thái</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                ${report.currentInventory.map(product => {
                                                    const stockValue = product.stock * product.costPrice;
                                                    let status, statusClass;
                                                    if (product.stock === 0) {
                                                        status = 'Hết hàng';
                                                        statusClass = 'bg-danger';
                                                    } else if (product.stock <= product.minStock) {
                                                        status = 'Sắp hết';
                                                        statusClass = 'bg-warning';
                                                    } else {
                                                        status = 'Đủ hàng';
                                                        statusClass = 'bg-success';
                                                    }
                                                    return `
                                                        <tr>
                                                            <td>${product.code}</td>
                                                            <td>${product.name}</td>
                                                            <td><strong>${product.stock}</strong> ${product.unit}</td>
                                                            <td>${this.formatCurrency(product.costPrice)}</td>
                                                            <td><strong>${this.formatCurrency(stockValue)}</strong></td>
                                                            <td><span class="badge ${statusClass}">${status}</span></td>
                                                        </tr>
                                                    `;
                                                }).join('')}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <p class="text-muted me-auto mb-0">
                                <small><i class="bi bi-calendar-range"></i> Kỳ báo cáo: ${new Date(report.period.start).toLocaleDateString('vi-VN')} - ${new Date(report.period.end).toLocaleDateString('vi-VN')}</small>
                            </p>
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        this.showReportModal(modalContent);
    }

    showReportModal(modalContent) {
        // Remove old modal if exists
        const oldModal = document.getElementById('viewReportModal');
        if (oldModal) oldModal.remove();
        
        // Add modal to body
        document.body.insertAdjacentHTML('beforeend', modalContent);
        
        // Show modal
        const modal = new bootstrap.Modal(document.getElementById('viewReportModal'));
        modal.show();
    }

    displayMonthlyReports() {
        const container = document.getElementById('monthlyReportsList');
        
        if (this.monthlySnapshots.length === 0) {
            container.innerHTML = '<p class="text-muted text-center py-4">Chưa có báo cáo nào. Hãy tạo báo cáo đầu tiên!</p>';
            return;
        }
        
        container.innerHTML = this.monthlySnapshots.map(snapshot => `
            <div class="card mb-3">
                <div class="card-header bg-primary text-white d-flex justify-content-between align-items-center">
                    <h5 class="mb-0">
                        <i class="bi bi-calendar3"></i> Báo Cáo Tháng ${snapshot.monthName}
                    </h5>
                    <div>
                        <button class="btn btn-sm btn-light" onclick="app.viewMonthlyReport(${snapshot.id})">
                            <i class="bi bi-eye"></i> Xem Chi Tiết
                        </button>
                        <button class="btn btn-sm btn-danger" onclick="app.deleteMonthlyReport(${snapshot.id})">
                            <i class="bi bi-trash"></i>
                        </button>
                    </div>
                </div>
                <div class="card-body">
                    <div class="row">
                        <div class="col-md-3">
                            <div class="text-center p-3 border rounded">
                                <i class="bi bi-box-seam fs-3 text-primary"></i>
                                <h4 class="mt-2">${snapshot.totalProducts}</h4>
                                <small class="text-muted">Loại nguyên liệu</small>
                            </div>
                        </div>
                        <div class="col-md-3">
                            <div class="text-center p-3 border rounded">
                                <i class="bi bi-arrow-down-circle fs-3 text-success"></i>
                                <h4 class="mt-2">${snapshot.totalImports}</h4>
                                <small class="text-muted">Phiếu nhập</small>
                                <p class="mb-0 mt-1"><strong>${this.formatCurrency(snapshot.totalImportValue)}</strong></p>
                            </div>
                        </div>
                        <div class="col-md-3">
                            <div class="text-center p-3 border rounded">
                                <i class="bi bi-arrow-up-circle fs-3 text-warning"></i>
                                <h4 class="mt-2">${snapshot.totalExports}</h4>
                                <small class="text-muted">Phiếu xuất</small>
                                <p class="mb-0 mt-1"><strong>${this.formatCurrency(snapshot.totalExportCost)}</strong></p>
                            </div>
                        </div>
                        <div class="col-md-3">
                            <div class="text-center p-3 border rounded">
                                <i class="bi bi-cash-stack fs-3 text-info"></i>
                                <h4 class="mt-2">${this.formatCurrency(snapshot.totalInventoryValue)}</h4>
                                <small class="text-muted">Giá trị tồn kho</small>
                            </div>
                        </div>
                    </div>
                    <div class="row mt-3">
                        <div class="col-md-6">
                            <p class="mb-1"><i class="bi bi-exclamation-triangle text-warning"></i> Sắp hết: <strong>${snapshot.lowStockItems}</strong> mặt hàng</p>
                        </div>
                        <div class="col-md-6">
                            <p class="mb-1"><i class="bi bi-x-circle text-danger"></i> Hết hàng: <strong>${snapshot.outOfStockItems}</strong> mặt hàng</p>
                        </div>
                    </div>
                    <p class="text-muted mb-0 mt-2">
                        <small><i class="bi bi-clock"></i> Tạo lúc: ${this.formatDate(snapshot.createdDate)} ${new Date(snapshot.createdDate).toLocaleTimeString('vi-VN')}</small>
                    </p>
                </div>
            </div>
        `).join('');
    }

    viewMonthlyReport(id) {
        const snapshot = this.monthlySnapshots.find(s => s.id === id);
        if (!snapshot) return;
        
        const modalContent = `
            <div class="modal fade" id="reportDetailModal" tabindex="-1">
                <div class="modal-dialog modal-xl">
                    <div class="modal-content">
                        <div class="modal-header bg-primary text-white">
                            <h5 class="modal-title">Chi Tiết Báo Cáo Tháng ${snapshot.monthName}</h5>
                            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body">
                            <h6 class="mb-3">Trạng Thái Tồn Kho Cuối Tháng</h6>
                            <div class="table-responsive" style="max-height: 500px; overflow-y: auto;">
                                <table class="table table-striped table-sm">
                                    <thead class="sticky-top bg-white">
                                        <tr>
                                            <th>Mã NL</th>
                                            <th>Tên Nguyên Liệu</th>
                                            <th>Đơn Vị</th>
                                            <th>Tồn Kho</th>
                                            <th>Giá Nhập</th>
                                            <th>Giá Trị</th>
                                            <th>Trạng Thái</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${snapshot.inventory.map(product => {
                                            const stockValue = product.stock * product.costPrice;
                                            let status, statusClass;
                                            if (product.stock === 0) {
                                                status = 'Hết hàng';
                                                statusClass = 'bg-danger';
                                            } else if (product.stock <= product.minStock) {
                                                status = 'Sắp hết';
                                                statusClass = 'bg-warning';
                                            } else {
                                                status = 'Đủ hàng';
                                                statusClass = 'bg-success';
                                            }
                                            return `
                                                <tr>
                                                    <td>${product.code}</td>
                                                    <td>${product.name}</td>
                                                    <td>${product.unit}</td>
                                                    <td><strong>${product.stock}</strong></td>
                                                    <td>${this.formatCurrency(product.costPrice)}</td>
                                                    <td><strong>${this.formatCurrency(stockValue)}</strong></td>
                                                    <td><span class="badge ${statusClass}">${status}</span></td>
                                                </tr>
                                            `;
                                        }).join('')}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        // Remove old modal if exists
        const oldModal = document.getElementById('reportDetailModal');
        if (oldModal) oldModal.remove();
        
        // Add modal to body
        document.body.insertAdjacentHTML('beforeend', modalContent);
        
        // Show modal
        const modal = new bootstrap.Modal(document.getElementById('reportDetailModal'));
        modal.show();
    }

    deleteMonthlyReport(id) {
        const snapshot = this.monthlySnapshots.find(s => s.id === id);
        if (!snapshot) return;
        
        if (!confirm(`⚠️ Bạn có chắc chắn muốn xóa báo cáo tháng ${snapshot.monthName}?\n\nHành động này không thể hoàn tác!`)) {
            return;
        }
        
        this.monthlySnapshots = this.monthlySnapshots.filter(s => s.id !== id);
        this.saveData('monthlySnapshots', this.monthlySnapshots);
        this.displayMonthlyReports();
        
        alert('✅ Đã xóa báo cáo thành công!');
    }

    importData(event) {
        const file = event.target.files[0];
        if (!file) return;

        if (!file.name.endsWith('.json')) {
            alert('❌ Vui lòng chọn file JSON!');
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                
                // Validate data structure
                if (!data.products || !Array.isArray(data.products)) {
                    throw new Error('Dữ liệu không hợp lệ!');
                }

                // Confirm before importing
                if (!confirm('⚠️ Nhập dữ liệu sẽ GHI ĐÈ toàn bộ dữ liệu hiện tại!\n\nBạn có chắc chắn muốn tiếp tục?')) {
                    event.target.value = '';
                    return;
                }

                // Import data
                this.products = data.products || [];
                this.imports = data.imports || [];
                this.exports = data.exports || [];
                this.adjustments = data.adjustments || [];
                this.monthlySnapshots = data.monthlySnapshots || [];
                this.revenueTransactions = data.revenueTransactions || [];

                // Save to localStorage
                this.saveData('products', this.products);
                this.saveData('imports', this.imports);
                this.saveData('exports', this.exports);
                this.saveData('adjustments', this.adjustments);
                this.saveData('monthlySnapshots', this.monthlySnapshots);
                this.saveData('revenueTransactions', this.revenueTransactions);

                // Refresh display
                this.updateDashboard();
                this.displayProducts();

                alert(`✅ Nhập dữ liệu thành công!\n\n📦 Sản phẩm: ${this.products.length}\n📥 Phiếu nhập: ${this.imports.length}\n📤 Phiếu xuất: ${this.exports.length}\n⚙️ Điều chỉnh: ${this.adjustments.length}\n💰 Giao dịch doanh thu: ${this.revenueTransactions.length}`);
                
            } catch (error) {
                alert('❌ Lỗi khi đọc file!\n\n' + error.message);
            }
            
            event.target.value = '';
        };

        reader.readAsText(file);
    }

    clearAllData() {
        if (!confirm('⚠️ CẢNH BÁO: Bạn có chắc chắn muốn XÓA TOÀN BỘ dữ liệu?\n\nHành động này KHÔNG THỂ HOÀN TÁC!')) {
            return;
        }

        if (!confirm('⚠️ XÁC NHẬN LẦN CUỐI:\n\nTất cả sản phẩm, lịch sử nhập/xuất sẽ bị xóa vĩnh viễn!\n\nBạn có chắc chắn?')) {
            return;
        }

        // Clear data
        this.products = [];
        this.imports = [];
        this.exports = [];
        this.adjustments = [];
        this.monthlySnapshots = [];
        this.revenueTransactions = [];

        this.saveAllData();
        this.flushPendingSaves();

        // Refresh display
        this.updateDashboard();
        this.displayProducts();

        alert('✅ Đã xóa toàn bộ dữ liệu thành công!');
    }

    // Auto Backup Functions
    setupAutoBackup() {
        // Kiểm tra và tạo backup tự động mỗi ngày
        const lastBackupDate = localStorage.getItem('lastAutoBackupDate');
        const lastFileBackupDate = localStorage.getItem('lastFileBackupDate');
        const today = new Date().toDateString();
        
        if (lastBackupDate !== today) {
            this.createAutoBackup();
            localStorage.setItem('lastAutoBackupDate', today);
        }

        // Tự động backup mỗi 24 giờ
        setInterval(() => {
            this.createAutoBackup();
            localStorage.setItem('lastAutoBackupDate', new Date().toDateString());
        }, 24 * 60 * 60 * 1000); // 24 hours
    }

    setupAutoSave() {
        // Auto-save mỗi 30 giây
        setInterval(() => {
            if (!this.hasUnsyncedChanges) return;
            this.saveAllData();
            console.log('✅ Auto-save completed at', new Date().toLocaleTimeString());
        }, 30000); // 30 seconds
    }

    setupBeforeUnload() {
        // Lưu dữ liệu khi đóng trang
        window.addEventListener('beforeunload', () => {
            if (!this.hasUnsyncedChanges) return;
            this.saveAllData();
            this.flushPendingSaves(true);
            
            console.log('✅ Data saved before page unload');
        });
    }

    createAutoBackup() {
        try {
            const backupData = {
                products: this.products,
                imports: this.imports,
                exports: this.exports,
                adjustments: this.adjustments,
                monthlySnapshots: this.monthlySnapshots,
                revenueTransactions: this.revenueTransactions,
                backupDate: new Date().toISOString(),
                version: '1.0.0',
                autoBackup: true
            };

            // Lưu vào localStorage với key đặc biệt
            const backupKey = `autoBackup_${new Date().toISOString().split('T')[0]}`;
            localStorage.setItem(backupKey, JSON.stringify(backupData));

            // Giữ chỉ 7 bản backup gần nhất
            this.cleanOldBackups();

            console.log('✅ Auto backup created successfully:', backupKey);
        } catch (error) {
            console.error('❌ Auto backup failed:', error);
        }
    }

    cleanOldBackups() {
        try {
            const backupKeys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key.startsWith('autoBackup_')) {
                    backupKeys.push(key);
                }
            }

            // Sắp xếp theo ngày (mới nhất trước)
            backupKeys.sort().reverse();

            // Xóa các backup cũ hơn 7 ngày
            if (backupKeys.length > 7) {
                for (let i = 7; i < backupKeys.length; i++) {
                    localStorage.removeItem(backupKeys[i]);
                    console.log('🗑️ Deleted old backup:', backupKeys[i]);
                }
            }
        } catch (error) {
            console.error('❌ Failed to clean old backups:', error);
        }
    }

    listAutoBackups() {
        const backups = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith('autoBackup_')) {
                const date = key.replace('autoBackup_', '');
                backups.push({ key, date });
            }
        }
        return backups.sort((a, b) => b.date.localeCompare(a.date));
    }

    restoreFromAutoBackup(backupKey) {
        try {
            const backupData = JSON.parse(localStorage.getItem(backupKey));
            if (!backupData) {
                alert('❌ Không tìm thấy bản backup!');
                return;
            }

            if (!confirm(`⚠️ Khôi phục dữ liệu từ backup ngày ${backupData.backupDate.split('T')[0]}?\n\nDữ liệu hiện tại sẽ bị ghi đè!`)) {
                return;
            }

            // Restore data
            this.products = backupData.products || [];
            this.imports = backupData.imports || [];
            this.exports = backupData.exports || [];
            this.adjustments = backupData.adjustments || [];
            this.monthlySnapshots = backupData.monthlySnapshots || [];

            // Save to localStorage
            this.saveData('products', this.products);
            this.saveData('imports', this.imports);
            this.saveData('exports', this.exports);
            this.saveData('adjustments', this.adjustments);
            this.saveData('monthlySnapshots', this.monthlySnapshots);

            // Refresh display
            this.updateDashboard();
            this.displayProducts();

            alert('✅ Khôi phục dữ liệu thành công!');
        } catch (error) {
            alert('❌ Lỗi khi khôi phục dữ liệu: ' + error.message);
        }
    }
}

// Global functions for buttons
function openProductModal() {
    document.getElementById('productForm').reset();
    document.getElementById('productId').value = '';
    document.getElementById('productConversionUnit').value = '';
    document.getElementById('productConversionRate').value = '';
    document.getElementById('productBaseUnitLabel').textContent = 'đơn vị cơ bản';
    document.getElementById('productModalTitle').textContent = 'Thêm Nguyên Liệu Mới';
}

function saveProduct() {
    const id = document.getElementById('productId').value;
    let code = document.getElementById('productCode').value;
    const name = document.getElementById('productName').value;
    const unit = document.getElementById('productUnit').value;
    const costPrice = parseFloat(document.getElementById('productCostPrice').value);
    const salePrice = costPrice; // Không cần giá bán cho nguyên liệu
    const minStock = parseInt(document.getElementById('productMinStock').value);
    const conversionUnit = document.getElementById('productConversionUnit').value;
    const conversionRate = parseFloat(document.getElementById('productConversionRate').value);

    if (!name || !unit || !costPrice) {
        alert('Vui lòng điền đầy đủ thông tin!');
        return;
    }

    if (id) {
        // Edit existing product - giữ nguyên mã cũ
        const product = app.products.find(p => p.id === parseInt(id));
        if (product) {
            product.name = name;
            product.unit = unit;
            product.costPrice = costPrice;
            product.salePrice = salePrice;
            product.minStock = minStock;
            product.conversionUnit = conversionUnit || null;
            product.conversionRate = conversionRate || null;
        }
    } else {
        // Add new product - tự động tạo mã
        code = app.generateProductCode();
        const newProduct = {
            id: Date.now(),
            code: code,
            name: name,
            unit: unit,
            costPrice: costPrice,
            salePrice: salePrice,
            stock: 0,
            minStock: minStock,
            conversionUnit: conversionUnit || null,
            conversionRate: conversionRate || null
        };
        app.products.push(newProduct);
    }

    app.saveData('products', app.products);
    app.displayProducts();
    app.updateDashboard();
    
    bootstrap.Modal.getInstance(document.getElementById('productModal')).hide();
}

// Monthly Report Functions
class MonthlyReportManager {
    static createSnapshot() {
        const now = new Date();
        const monthYear = `${now.getMonth() + 1}/${now.getFullYear()}`;
        const monthName = now.toLocaleDateString('vi-VN', { month: 'long', year: 'numeric' });
        
        // Tính toán thống kê tháng
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        
        const monthImports = app.imports.filter(imp => {
            const impDate = new Date(imp.date);
            return impDate >= startOfMonth && impDate <= endOfMonth;
        });
        
        const monthExports = app.exports.filter(exp => {
            const expDate = new Date(exp.date);
            return expDate >= startOfMonth && expDate <= endOfMonth;
        });
        
        // Tính tổng giá trị
        const totalImportValue = monthImports.reduce((sum, imp) => sum + (imp.total || 0), 0);
        const totalExportCost = monthExports.reduce((sum, exp) => sum + (exp.totalCost || 0), 0);
        const totalInventoryValue = app.products.reduce((sum, p) => sum + (p.stock * p.costPrice), 0);
        
        // Tạo snapshot
        const snapshot = {
            id: Date.now(),
            monthYear: monthYear,
            monthName: monthName,
            createdDate: now.toISOString(),
            inventory: JSON.parse(JSON.stringify(app.products)), // Deep copy
            totalProducts: app.products.length,
            totalImports: monthImports.length,
            totalExports: monthExports.length,
            totalImportValue: totalImportValue,
            totalExportCost: totalExportCost,
            totalInventoryValue: totalInventoryValue,
            lowStockItems: app.products.filter(p => p.stock <= p.minStock && p.stock > 0).length,
            outOfStockItems: app.products.filter(p => p.stock === 0).length
        };
        
        return snapshot;
    }
}

// Revenue Management Functions
WarehouseManager.prototype.displayRevenueSection = function() {
    this.updateRevenueSummary();
    this.displayRevenueTransactions();
    this.displayRevenueCategoryStats();
};

WarehouseManager.prototype.handleRevenueIncome = function() {
    const category = document.getElementById('incomeCategory').value;
    const paymentMethod = document.getElementById('incomePaymentMethod').value;
    const amount = parseFloat(document.getElementById('incomeAmount').value);
    const selectedDate = document.getElementById('incomeDate').value || this.getTodayDateValue();
    const description = document.getElementById('incomeDescription').value;
    const note = document.getElementById('incomeNote').value;
    const transactionTime = this.buildIsoFromDateInput(selectedDate);

    const transaction = {
        id: Date.now(),
        type: 'income',
        category: category,
        paymentMethod: paymentMethod,
        amount: amount,
        description: description,
        note: note,
        date: selectedDate,
        time: transactionTime
    };

    this.revenueTransactions.push(transaction);
    this.saveData('revenueTransactions', this.revenueTransactions);
    
    // Reset form
    document.getElementById('revenueIncomeForm').reset();
    const incomeDateInput = document.getElementById('incomeDate');
    if (incomeDateInput) {
        incomeDateInput.value = this.getTodayDateValue();
    }
    
    // Update display
    this.displayRevenueSection();
    
    alert(`✅ Đã ghi nhận thu ${this.formatCurrency(amount)}!`);
};

WarehouseManager.prototype.handleRevenueExpense = function() {
    const category = document.getElementById('expenseCategory').value;
    const paymentMethod = document.getElementById('expensePaymentMethod').value;
    const amount = parseFloat(document.getElementById('expenseAmount').value);
    const selectedDate = document.getElementById('expenseDate').value || this.getTodayDateValue();
    const description = document.getElementById('expenseDescription').value;
    const note = document.getElementById('expenseNote').value;
    const transactionTime = this.buildIsoFromDateInput(selectedDate);

    const transaction = {
        id: Date.now(),
        type: 'expense',
        category: category,
        paymentMethod: paymentMethod,
        amount: amount,
        description: description,
        note: note,
        date: selectedDate,
        time: transactionTime
    };

    this.revenueTransactions.push(transaction);
    this.saveData('revenueTransactions', this.revenueTransactions);
    
    // Reset form
    document.getElementById('revenueExpenseForm').reset();
    const expenseDateInput = document.getElementById('expenseDate');
    if (expenseDateInput) {
        expenseDateInput.value = this.getTodayDateValue();
    }
    
    // Update display
    this.displayRevenueSection();
    
    alert(`✅ Đã ghi nhận chi ${this.formatCurrency(amount)}!`);
};

WarehouseManager.prototype.updateRevenueSummary = function() {
    const filterPeriod = document.getElementById('revenueFilterPeriod')?.value || 'all';
    const filteredTransactions = this.filterTransactionsByPeriod(this.revenueTransactions, filterPeriod);
    
    const cashIncome = filteredTransactions
        .filter(t => t.type === 'income' && t.paymentMethod === 'cash')
        .reduce((sum, t) => sum + t.amount, 0);
    
    const transferIncome = filteredTransactions
        .filter(t => t.type === 'income' && t.paymentMethod === 'transfer')
        .reduce((sum, t) => sum + t.amount, 0);
    
    const totalExpense = filteredTransactions
        .filter(t => t.type === 'expense')
        .reduce((sum, t) => sum + t.amount, 0);
    
    const netProfit = (cashIncome + transferIncome) - totalExpense;
    
    document.getElementById('revenueCashTotal').textContent = this.formatCurrency(cashIncome);
    document.getElementById('revenueTransferTotal').textContent = this.formatCurrency(transferIncome);
    document.getElementById('expenseTotal').textContent = this.formatCurrency(totalExpense);
    document.getElementById('revenueNetTotal').textContent = this.formatCurrency(netProfit);
    
    // Calculate TOTAL CASH and TOTAL ACCOUNT from ALL transactions (not filtered)
    const allCashIncome = this.revenueTransactions
        .filter(t => t.type === 'income' && t.paymentMethod === 'cash')
        .reduce((sum, t) => sum + t.amount, 0);
    
    const allCashExpense = this.revenueTransactions
        .filter(t => t.type === 'expense' && t.paymentMethod === 'cash')
        .reduce((sum, t) => sum + t.amount, 0);
    
    const allTransferIncome = this.revenueTransactions
        .filter(t => t.type === 'income' && t.paymentMethod === 'transfer')
        .reduce((sum, t) => sum + t.amount, 0);
    
    const allTransferExpense = this.revenueTransactions
        .filter(t => t.type === 'expense' && t.paymentMethod === 'transfer')
        .reduce((sum, t) => sum + t.amount, 0);
    
    const totalCashRemaining = allCashIncome - allCashExpense;
    const totalAccountMoney = allTransferIncome - allTransferExpense;
    
    document.getElementById('totalCashRemaining').textContent = this.formatCurrency(totalCashRemaining);
    document.getElementById('totalAccountMoney').textContent = this.formatCurrency(totalAccountMoney);
    
    // Update card colors for total cash
    const cashCard = document.getElementById('totalCashRemaining').closest('.card');
    if (totalCashRemaining >= 0) {
        cashCard.classList.remove('border-danger');
        cashCard.classList.add('border-warning');
        document.getElementById('totalCashRemaining').classList.remove('text-danger');
        document.getElementById('totalCashRemaining').classList.add('text-warning');
    } else {
        cashCard.classList.remove('border-warning');
        cashCard.classList.add('border-danger');
        document.getElementById('totalCashRemaining').classList.remove('text-warning');
        document.getElementById('totalCashRemaining').classList.add('text-danger');
    }
    
    // Update card colors for total account
    const accountCard = document.getElementById('totalAccountMoney').closest('.card');
    if (totalAccountMoney >= 0) {
        accountCard.classList.remove('border-danger');
        accountCard.classList.add('border-success');
        document.getElementById('totalAccountMoney').classList.remove('text-danger');
        document.getElementById('totalAccountMoney').classList.add('text-success');
    } else {
        accountCard.classList.remove('border-success');
        accountCard.classList.add('border-danger');
        document.getElementById('totalAccountMoney').classList.remove('text-success');
        document.getElementById('totalAccountMoney').classList.add('text-danger');
    }
    
    // Update card colors based on profit
    const netCard = document.getElementById('revenueNetTotal').closest('.card');
    if (netProfit >= 0) {
        netCard.classList.remove('border-danger');
        netCard.classList.add('border-primary');
        document.getElementById('revenueNetTotal').classList.remove('text-danger');
        document.getElementById('revenueNetTotal').classList.add('text-primary');
    } else {
        netCard.classList.remove('border-primary');
        netCard.classList.add('border-danger');
        document.getElementById('revenueNetTotal').classList.remove('text-primary');
        document.getElementById('revenueNetTotal').classList.add('text-danger');
    }
};

WarehouseManager.prototype.displayRevenueTransactions = function() {
    const filterType = document.getElementById('revenueFilterType').value;
    const filterPeriod = document.getElementById('revenueFilterPeriod').value;
    
    let transactions = this.filterTransactionsByPeriod(this.revenueTransactions, filterPeriod);
    
    if (filterType !== 'all') {
        transactions = transactions.filter(t => t.type === filterType);
    }
    
    // Sort by time (newest first)
    transactions.sort((a, b) => new Date(b.time) - new Date(a.time));
    
    const tbody = document.getElementById('revenueTransactionsList');
    
    if (transactions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">Không có giao dịch nào</td></tr>';
        return;
    }
    
    const categoryLabels = {
        // Income
        'sales': 'Bán hàng',
        'service': 'Dịch vụ',
        'other': 'Thu khác',
        // Expense
        'ingredient': 'Nguyên liệu',
        'salary': 'Lương',
        'rent': 'Thuê MB',
        'utilities': 'Điện nước',
        'marketing': 'Marketing',
        'equipment': 'Thiết bị',
        'maintenance': 'Bảo trì'
    };
    
    tbody.innerHTML = transactions.map(t => {
        const typeClass = t.type === 'income' ? 'text-success' : 'text-danger';
        const typeIcon = t.type === 'income' ? 'arrow-up-circle' : 'arrow-down-circle';
        const typeLabel = t.type === 'income' ? 'Thu' : 'Chi';
        const paymentIcon = t.paymentMethod === 'cash' ? 'cash-stack' : 'credit-card';
        const paymentLabel = t.paymentMethod === 'cash' ? 'Tiền mặt' : 'CK';
        
        return `
            <tr>
                <td>${new Date(t.time).toLocaleString('vi-VN')}</td>
                <td><span class="badge bg-${t.type === 'income' ? 'success' : 'danger'}">
                    <i class="bi bi-${typeIcon}"></i> ${typeLabel}
                </span></td>
                <td>${categoryLabels[t.category] || t.category}</td>
                <td>${t.description}</td>
                <td><i class="bi bi-${paymentIcon}"></i> ${paymentLabel}</td>
                <td class="${typeClass}"><strong>${this.formatCurrency(t.amount)}</strong></td>
                <td>
                    <button class="btn btn-sm btn-warning" onclick="app.editRevenueTransaction(${t.id})" title="Sửa">
                        <i class="bi bi-pencil"></i>
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="app.deleteRevenueTransaction(${t.id})" title="Xóa">
                        <i class="bi bi-trash"></i>
                    </button>
                </td>
            </tr>
        `;
    }).join('');
    
    this.updateRevenueSummary();
};

WarehouseManager.prototype.displayRevenueCategoryStats = function() {
    const filterPeriod = document.getElementById('revenueFilterPeriod')?.value || 'all';
    const transactions = this.filterTransactionsByPeriod(this.revenueTransactions, filterPeriod);
    
    // Income stats
    const incomeByCategory = {};
    transactions.filter(t => t.type === 'income').forEach(t => {
        incomeByCategory[t.category] = (incomeByCategory[t.category] || 0) + t.amount;
    });
    
    // Expense stats
    const expenseByCategory = {};
    transactions.filter(t => t.type === 'expense').forEach(t => {
        expenseByCategory[t.category] = (expenseByCategory[t.category] || 0) + t.amount;
    });
    
    const categoryLabels = {
        'sales': 'Bán hàng',
        'service': 'Dịch vụ',
        'other': 'Thu khác',
        'ingredient': 'Nguyên liệu',
        'salary': 'Lương NV',
        'rent': 'Thuê mặt bằng',
        'utilities': 'Điện nước',
        'marketing': 'Marketing',
        'equipment': 'Thiết bị',
        'maintenance': 'Bảo trì'
    };
    
    // Display income stats
    const incomeDiv = document.getElementById('incomeCategoryStats');
    if (Object.keys(incomeByCategory).length === 0) {
        incomeDiv.innerHTML = '<p class="text-muted">Chưa có dữ liệu</p>';
    } else {
        const totalIncome = Object.values(incomeByCategory).reduce((a, b) => a + b, 0);
        incomeDiv.innerHTML = Object.entries(incomeByCategory)
            .sort((a, b) => b[1] - a[1])
            .map(([cat, amount]) => {
                const percent = totalIncome > 0 ? ((amount / totalIncome) * 100).toFixed(1) : 0;
                return `
                    <div class="mb-2">
                        <div class="d-flex justify-content-between">
                            <small>${categoryLabels[cat] || cat}</small>
                            <small><strong>${this.formatCurrency(amount)}</strong> (${percent}%)</small>
                        </div>
                        <div class="progress" style="height: 8px;">
                            <div class="progress-bar bg-success" style="width: ${percent}%"></div>
                        </div>
                    </div>
                `;
            }).join('');
    }
    
    // Display expense stats
    const expenseDiv = document.getElementById('expenseCategoryStats');
    if (Object.keys(expenseByCategory).length === 0) {
        expenseDiv.innerHTML = '<p class="text-muted">Chưa có dữ liệu</p>';
    } else {
        const totalExpense = Object.values(expenseByCategory).reduce((a, b) => a + b, 0);
        expenseDiv.innerHTML = Object.entries(expenseByCategory)
            .sort((a, b) => b[1] - a[1])
            .map(([cat, amount]) => {
                const percent = totalExpense > 0 ? ((amount / totalExpense) * 100).toFixed(1) : 0;
                return `
                    <div class="mb-2">
                        <div class="d-flex justify-content-between">
                            <small>${categoryLabels[cat] || cat}</small>
                            <small><strong>${this.formatCurrency(amount)}</strong> (${percent}%)</small>
                        </div>
                        <div class="progress" style="height: 8px;">
                            <div class="progress-bar bg-danger" style="width: ${percent}%"></div>
                        </div>
                    </div>
                `;
            }).join('');
    }
};

WarehouseManager.prototype.showRevenueReportModal = function({ title, periodLabel, transactions }) {
    const incomeTotal = transactions
        .filter(t => t.type === 'income')
        .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

    const expenseTotal = transactions
        .filter(t => t.type === 'expense')
        .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

    const netProfit = incomeTotal - expenseTotal;

    const categoryLabels = {
        sales: 'Bán hàng',
        service: 'Dịch vụ',
        other: 'Khác',
        ingredient: 'Nguyên liệu',
        salary: 'Lương',
        rent: 'Thuê MB',
        utilities: 'Điện nước',
        marketing: 'Marketing',
        equipment: 'Thiết bị',
        maintenance: 'Bảo trì'
    };

    const sortedTransactions = [...transactions].sort((a, b) => {
        const timeA = new Date(a.time || a.date).getTime();
        const timeB = new Date(b.time || b.date).getTime();
        return timeB - timeA;
    });

    const modalContent = `
        <div class="modal fade" id="revenueReportModal" tabindex="-1">
            <div class="modal-dialog modal-xl">
                <div class="modal-content">
                    <div class="modal-header bg-success text-white">
                        <h5 class="modal-title"><i class="bi bi-cash-coin"></i> ${title}</h5>
                        <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <div class="row mb-3">
                            <div class="col-md-3">
                                <div class="card border-success">
                                    <div class="card-body text-center p-2">
                                        <h6 class="mb-1 text-success">${this.formatCurrency(incomeTotal)}</h6>
                                        <small class="text-muted">Tổng Thu</small>
                                    </div>
                                </div>
                            </div>
                            <div class="col-md-3">
                                <div class="card border-danger">
                                    <div class="card-body text-center p-2">
                                        <h6 class="mb-1 text-danger">${this.formatCurrency(expenseTotal)}</h6>
                                        <small class="text-muted">Tổng Chi</small>
                                    </div>
                                </div>
                            </div>
                            <div class="col-md-3">
                                <div class="card border-primary">
                                    <div class="card-body text-center p-2">
                                        <h6 class="mb-1 ${netProfit >= 0 ? 'text-primary' : 'text-danger'}">${this.formatCurrency(netProfit)}</h6>
                                        <small class="text-muted">Lợi Nhuận</small>
                                    </div>
                                </div>
                            </div>
                            <div class="col-md-3">
                                <div class="card border-info">
                                    <div class="card-body text-center p-2">
                                        <h6 class="mb-1">${sortedTransactions.length}</h6>
                                        <small class="text-muted">Số Giao Dịch</small>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <p class="text-muted mb-3"><small><i class="bi bi-calendar3"></i> Kỳ báo cáo: ${periodLabel}</small></p>

                        <div class="table-responsive" style="max-height: 520px; overflow-y: auto;">
                            <table class="table table-striped table-sm">
                                <thead class="sticky-top bg-white">
                                    <tr>
                                        <th>Thời Gian</th>
                                        <th>Loại</th>
                                        <th>Danh Mục</th>
                                        <th>Mô Tả</th>
                                        <th>Hình Thức</th>
                                        <th>Số Tiền</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${sortedTransactions.length === 0 ? `
                                        <tr>
                                            <td colspan="6" class="text-center text-muted">Không có giao dịch trong kỳ đã chọn</td>
                                        </tr>
                                    ` : sortedTransactions.map((t) => {
                                        const typeClass = t.type === 'income' ? 'success' : 'danger';
                                        const typeLabel = t.type === 'income' ? 'Thu' : 'Chi';
                                        const paymentLabel = t.paymentMethod === 'cash' ? 'Tiền mặt' : 'CK';
                                        const timeText = new Date(t.time || t.date).toLocaleString('vi-VN');
                                        return `
                                            <tr>
                                                <td>${timeText}</td>
                                                <td><span class="badge bg-${typeClass}">${typeLabel}</span></td>
                                                <td>${categoryLabels[t.category] || t.category}</td>
                                                <td>${t.description || ''}</td>
                                                <td>${paymentLabel}</td>
                                                <td class="text-${typeClass}"><strong>${this.formatCurrency(Number(t.amount) || 0)}</strong></td>
                                            </tr>
                                        `;
                                    }).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    const oldModal = document.getElementById('revenueReportModal');
    if (oldModal) oldModal.remove();

    document.body.insertAdjacentHTML('beforeend', modalContent);
    const modal = new bootstrap.Modal(document.getElementById('revenueReportModal'));
    modal.show();
};

WarehouseManager.prototype.showRevenueReportByDay = function() {
    const selectedDate = document.getElementById('revenueFilterDate')?.value || this.getTodayDateValue();
    const date = new Date(`${selectedDate}T00:00:00`);

    if (Number.isNaN(date.getTime())) {
        alert('❌ Ngày báo cáo doanh thu không hợp lệ!');
        return;
    }

    const transactions = this.filterTransactionsByPeriod(this.revenueTransactions, 'day');
    this.showRevenueReportModal({
        title: 'Báo Cáo Doanh Thu Theo Ngày',
        periodLabel: date.toLocaleDateString('vi-VN'),
        transactions
    });
};

WarehouseManager.prototype.showRevenueReportByMonth = function() {
    const selectedMonth = document.getElementById('revenueFilterMonth')?.value || this.getCurrentMonthValue();
    const [yearText, monthText] = selectedMonth.split('-');
    const year = parseInt(yearText, 10);
    const month = parseInt(monthText, 10);

    if (Number.isNaN(year) || Number.isNaN(month) || month < 1 || month > 12) {
        alert('❌ Tháng báo cáo doanh thu không hợp lệ!');
        return;
    }

    const transactions = this.filterTransactionsByPeriod(this.revenueTransactions, 'month');
    this.showRevenueReportModal({
        title: 'Báo Cáo Doanh Thu Theo Tháng',
        periodLabel: `Tháng ${month}/${year}`,
        transactions
    });
};

WarehouseManager.prototype.showRevenueReportByYear = function() {
    const selectedYear = parseInt(document.getElementById('revenueFilterYear')?.value || this.getCurrentYearValue(), 10);

    if (Number.isNaN(selectedYear) || selectedYear < 2000 || selectedYear > 2100) {
        alert('❌ Năm báo cáo doanh thu không hợp lệ!');
        return;
    }

    const transactions = this.filterTransactionsByPeriod(this.revenueTransactions, 'year');
    this.showRevenueReportModal({
        title: 'Báo Cáo Doanh Thu Theo Năm',
        periodLabel: `Năm ${selectedYear}`,
        transactions
    });
};

WarehouseManager.prototype.showRevenueReportAll = function() {
    this.showRevenueReportModal({
        title: 'Báo Cáo Toàn Bộ Lịch Sử Giao Dịch',
        periodLabel: 'Toàn bộ thời gian',
        transactions: this.revenueTransactions
    });
};

WarehouseManager.prototype.filterTransactionsByPeriod = function(transactions, period) {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const selectedDate = document.getElementById('revenueFilterDate')?.value || today;
    const selectedMonth = document.getElementById('revenueFilterMonth')?.value || this.getCurrentMonthValue();
    const selectedYear = parseInt(document.getElementById('revenueFilterYear')?.value || this.getCurrentYearValue(), 10);

    const normalizeDate = (transaction) => {
        if (transaction.time) {
            const dateFromTime = new Date(transaction.time);
            if (!Number.isNaN(dateFromTime.getTime())) {
                return dateFromTime;
            }
        }

        const dateFromDate = new Date(transaction.date);
        return Number.isNaN(dateFromDate.getTime()) ? null : dateFromDate;
    };
    
    switch(period) {
        case 'day':
            return transactions.filter(t => {
                const date = normalizeDate(t);
                if (!date) return false;
                return this.toDateInputValue(date.toISOString()) === selectedDate;
            });

        case 'today':
            return transactions.filter(t => t.date === today);
        
        case 'week':
            const weekAgo = new Date(now);
            weekAgo.setDate(weekAgo.getDate() - 7);
            return transactions.filter(t => {
                const date = normalizeDate(t);
                return date ? date >= weekAgo : false;
            });
        
        case 'month':
            return transactions.filter(t => {
                const date = normalizeDate(t);
                if (!date) return false;

                const monthValue = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
                return monthValue === selectedMonth;
            });

        case 'year':
            if (Number.isNaN(selectedYear)) return [];

            return transactions.filter(t => {
                const date = normalizeDate(t);
                return date ? date.getFullYear() === selectedYear : false;
            });
        
        case 'all':
        default:
            return transactions;
    }
};

WarehouseManager.prototype.deleteRevenueTransaction = function(id) {
    if (!confirm('⚠️ Bạn có chắc chắn muốn xóa giao dịch này?')) {
        return;
    }
    
    this.revenueTransactions = this.revenueTransactions.filter(t => t.id !== id);
    this.saveData('revenueTransactions', this.revenueTransactions);
    this.displayRevenueTransactions();
    
    alert('✅ Đã xóa giao dịch!');
};

WarehouseManager.prototype.editRevenueTransaction = function(id) {
    const transaction = this.revenueTransactions.find(t => t.id === id);
    if (!transaction) return;
    
    // Set modal header color based on transaction type
    const modalHeader = document.getElementById('revenueEditModalHeader');
    if (transaction.type === 'income') {
        modalHeader.className = 'modal-header bg-success text-white';
        document.getElementById('revenueEditModalTitle').innerHTML = '<i class="bi bi-pencil"></i> Chỉnh Sửa Giao Dịch Thu';
        document.getElementById('editTypeDisplay').value = 'Thu';
    } else {
        modalHeader.className = 'modal-header bg-danger text-white';
        document.getElementById('revenueEditModalTitle').innerHTML = '<i class="bi bi-pencil"></i> Chỉnh Sửa Giao Dịch Chi';
        document.getElementById('editTypeDisplay').value = 'Chi';
    }
    
    // Populate category options based on type
    const categorySelect = document.getElementById('editCategory');
    if (transaction.type === 'income') {
        categorySelect.innerHTML = `
            <option value="sales">Bán hàng</option>
            <option value="service">Dịch vụ</option>
            <option value="other">Thu nhập khác</option>
        `;
    } else {
        categorySelect.innerHTML = `
            <option value="ingredient">Nhập nguyên liệu</option>
            <option value="salary">Lương nhân viên</option>
            <option value="rent">Thuê mặt bằng</option>
            <option value="utilities">Điện nước</option>
            <option value="marketing">Marketing</option>
            <option value="equipment">Thiết bị</option>
            <option value="maintenance">Bảo trì</option>
            <option value="other">Chi phí khác</option>
        `;
    }
    
    // Fill form with transaction data
    document.getElementById('editTransactionId').value = transaction.id;
    document.getElementById('editTransactionType').value = transaction.type;
    document.getElementById('editCategory').value = transaction.category;
    document.getElementById('editPaymentMethod').value = transaction.paymentMethod;
    document.getElementById('editAmount').value = transaction.amount;
    document.getElementById('editDescription').value = transaction.description;
    document.getElementById('editTransactionDate').value = this.toDateInputValue(transaction.time || transaction.date);
    document.getElementById('editNote').value = transaction.note || '';
    
    // Show modal
    const modal = new bootstrap.Modal(document.getElementById('revenueEditModal'));
    modal.show();
};

WarehouseManager.prototype.saveRevenueEdit = function() {
    const id = parseInt(document.getElementById('editTransactionId').value);
    const category = document.getElementById('editCategory').value;
    const paymentMethod = document.getElementById('editPaymentMethod').value;
    const amount = parseFloat(document.getElementById('editAmount').value);
    const description = document.getElementById('editDescription').value;
    const selectedDate = document.getElementById('editTransactionDate').value || this.getTodayDateValue();
    const note = document.getElementById('editNote').value;
    
    if (!category || !paymentMethod || !amount || !description || !selectedDate) {
        alert('⚠️ Vui lòng điền đầy đủ thông tin!');
        return;
    }
    
    // Find and update transaction
    const index = this.revenueTransactions.findIndex(t => t.id === id);
    if (index === -1) {
        alert('❌ Không tìm thấy giao dịch!');
        return;
    }
    
    const existingTransaction = this.revenueTransactions[index];
    const updatedTime = this.buildIsoFromDateInput(selectedDate, existingTransaction.time || existingTransaction.date);

    // Update transaction (keep original type, date, and time)
    this.revenueTransactions[index] = {
        ...existingTransaction,
        category: category,
        paymentMethod: paymentMethod,
        amount: amount,
        description: description,
        date: selectedDate,
        time: updatedTime,
        note: note
    };
    
    // Save and refresh
    this.saveData('revenueTransactions', this.revenueTransactions);
    this.displayRevenueTransactions();
    
    // Close modal
    const modal = bootstrap.Modal.getInstance(document.getElementById('revenueEditModal'));
    modal.hide();
    
    alert('✅ Đã cập nhật giao dịch!');
};

// Initialize app
let app;
document.addEventListener('DOMContentLoaded', async () => {
    app = new WarehouseManager();
    await app.initializeApp();
});
