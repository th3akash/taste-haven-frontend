document.addEventListener('DOMContentLoaded', () => {
    let inventoryChartInstance, consumptionChartInstance, inventoryReportChartInstance, wasteChartInstance;

    // Firebase Firestore instances
    let db, auth, userId;
    let isAuthReady = false; // Flag to track if auth state is resolved

    const appId = typeof __app_id !== 'undefined' ? __app_id : 'inventory-app-default';
    window.appId = appId;  // ✅ This makes it available in DevTools


    // --- Firebase Configuration Handling ---
    // In this environment, Firebase config is provided via __firebase_config.
    // If deploying elsewhere, you might fetch a firebase.config.json or use environment variables.
    try {
        if (typeof __firebase_config !== 'undefined' && __firebase_config) {
            firebaseConfig = JSON.parse(__firebase_config);
        } else {
            console.error("Firebase configuration (__firebase_config) is missing or empty. Application will not connect to Firebase.");
            showToast("Error: Firebase configuration is missing. Cannot initialize.", "error");
            // Display a more prominent error message to the user in the UI if possible.
            const bodyElement = document.querySelector('body');
            if (bodyElement) {
                 const errorDiv = document.createElement('div');
                 errorDiv.innerHTML = '<h1 style="color: red; text-align: center; padding: 20px;">Critical Error: Firebase Configuration Missing. Inventory system cannot load.</h1>';
                 bodyElement.prepend(errorDiv);
            }
            return; // Stop execution if config is essential and missing.
        }
    } catch (error) {
        console.error("Error parsing Firebase config:", error);
        showToast("Error: Firebase configuration is invalid. " + error.message, "error");
        return; // Stop execution if config is broken
    }

    // --- Global Variables & Selectors ---
    const navLinks = document.querySelectorAll('.nav-link');
    const contentSections = document.querySelectorAll('.content-section');
    const pageTitleElement = document.querySelector('.page-title');
    const genericModal = document.getElementById('genericModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalFormContent = document.getElementById('modalFormContent');
    const modalFormFooter = document.getElementById('modalFormFooter');
    const closeModalBtn = genericModal ? genericModal.querySelector('.close-btn') : null;
    const toastContainer = document.querySelector('.toast-container');
    const userIdDisplay = document.getElementById('user-id-display');
    const backButtonContainer = document.getElementById('back-button-container');


    // --- Data Arrays (will be populated by Firestore) ---
    let rawMaterials = [];
    let recipes = [];
    let purchaseOrders = [];
    let salesOrders = [];
    let wasteRecords = [];

    // --- Firebase Initialization ---
    async function initializeFirebase() {
        try {
            // Check if Firebase is already initialized (useful for HMR or multiple script loads)
            if (!firebase.apps.length) {
                const firebaseApp = firebase.initializeApp(firebaseConfig);
                db = firebase.firestore(firebaseApp);
                auth = firebase.auth(firebaseApp);
            } else {
                const firebaseApp = firebase.app(); // Get default app
                db = firebase.firestore(firebaseApp);
                auth = firebase.auth(firebaseApp);
            }

            // Enable Firestore logging for debugging if needed
            firebase.firestore.setLogLevel('debug'); // Can be 'debug', 'error', or 'silent'

            auth.onAuthStateChanged(async (user) => {
                const storedId = localStorage.getItem('tasteHavenUserId');

                if (user) {
                    userId = user.uid;
                    localStorage.setItem('tasteHavenUserId', user.uid);
                    window.userId = userId;
                    console.log("✅ Signed in user UID:", userId);
                } else if (storedId) {
                    userId = storedId;
                    try {
                        const anonUser = await auth.signInAnonymously();
                        userId = anonUser.user.uid;
                        localStorage.setItem('tasteHavenUserId', userId);
                        window.userId = userId;
                        console.log("✅ Anonymous user re-authenticated:", userId);
                    } catch (error) {
                        console.error("❌ Anonymous sign-in failed:", error);
                        showToast("Error: Firebase login failed.", "error");
                    }
                } else {
                    try {
                        const anonUser = await auth.signInAnonymously();
                        userId = anonUser.user.uid;
                        localStorage.setItem('tasteHavenUserId', userId);
                        window.userId = userId;
                        console.log("✅ Anonymous user signed in:", userId);
                    } catch (error) {
                        console.error("❌ Anonymous sign-in failed:", error);
                        showToast("Firebase anonymous login failed.", "error");
                    }
                }

                if (userIdDisplay) userIdDisplay.textContent = `User ID: ${userId}`;
                isAuthReady = true;
                window.isAuthReady = true;
                loadAllDataFromFirestore();
                setupInitialUI();
            });

        } catch (error) {
            console.error("Error initializing Firebase:", error);
            showToast("Error initializing Firebase: " + error.message, "error");
        }
    }

    function setupInitialUI() {
        initCharts();
        setActiveSection('dashboard');
        updateDashboardCards(); // Will show 0s initially
        renderAllTables();    // Will show "No data" messages initially
        setupTabs('#purchase-orders .tabs');
        setupTabs('#reports .tabs');
    }


    // --- Firestore Collection References ---
    const getCollectionRef = (collectionName) => {
        if (!isAuthReady || !userId) {
            // This warning is useful but can be noisy during initial load.
            // console.warn(`Firestore collection access attempted before auth ready or without userId for ${collectionName}.`);
            return null;
        }
        // Path: /artifacts/{appId}/users/{userId}/{your_collection_name}
        return db.collection('artifacts').doc(appId).collection('users').doc(userId).collection(collectionName);
    };


    // --- Data Loading from Firestore ---
    function loadAllDataFromFirestore() {
        if (!isAuthReady || !userId) {
            console.log("Auth not ready or no user ID, skipping Firestore data load.");
            // Optionally show a message to the user that data cannot be loaded.
            return;
        }
        console.log("loadAllDataFromFirestore called. User ID:", userId);

        const collectionsToLoad = [
            { name: 'rawMaterials', array: rawMaterials, renderFunc: renderMaterialsTable, updateFunc: () => { updateDashboardCards(); if (inventoryChartInstance) updateInventoryChart(); if (inventoryReportChartInstance) updateInventoryReportChart(); } },
            { name: 'recipes', array: recipes, renderFunc: renderRecipesTable, updateFunc: () => { updateDashboardCards(); if (consumptionChartInstance) updateConsumptionChart(); } },
            { name: 'purchaseOrders', array: purchaseOrders, renderFunc: renderPurchaseOrdersTables, updateFunc: updateDashboardCards },
            { name: 'salesOrders', array: salesOrders, renderFunc: renderSalesOrdersTable, updateFunc: null /* Add if SO affects dashboard cards */ },
            { name: 'wasteRecords', array: wasteRecords, renderFunc: renderWasteTable, updateFunc: () => { if (wasteChartInstance) updateWasteChart(); } }
        ];

        collectionsToLoad.forEach(collInfo => {
            const collectionRef = getCollectionRef(collInfo.name);
            if (collectionRef) {
                collectionRef.onSnapshot(snapshot => {
                    // Overwrite the local array with data from Firestore
                    // This ensures the local array 'collInfo.array' is reassigned, not just its contents.
                    // This might be tricky if other parts of the code hold a reference to the old array.
                    // A safer approach is to clear and push, or reassign and ensure all consumers use the new reference.
                    // For simplicity here, we'll reassign. If issues arise, switch to clear & push.
                    if (collInfo.name === 'rawMaterials') rawMaterials = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                    else if (collInfo.name === 'recipes') recipes = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                    else if (collInfo.name === 'purchaseOrders') purchaseOrders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                    else if (collInfo.name === 'salesOrders') salesOrders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                    else if (collInfo.name === 'wasteRecords') wasteRecords = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

                    console.log(`Loaded ${collInfo.name}:`, snapshot.docs.length, "items. Current local array:", eval(collInfo.name));


                    if (collInfo.renderFunc) collInfo.renderFunc();
                    if (collInfo.updateFunc) collInfo.updateFunc();
                }, error => {
                    console.error(`Error fetching ${collInfo.name}:`, error);
                    showToast(`Error loading ${collInfo.name}: ` + error.message, "error");
                });
            } else {
                console.warn(`Could not get collection reference for ${collInfo.name}. Auth ready: ${isAuthReady}, UserID: ${userId}`);
                 // If collection ref is null, render empty table to clear any old stale data
                if (collInfo.renderFunc) collInfo.renderFunc();
                if (collInfo.updateFunc) collInfo.updateFunc(); // Update dashboard with 0 counts
            }
        });
    }
    window.loadAllDataFromFirestore = loadAllDataFromFirestore;


    // --- Navigation ---
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const currentActive = document.querySelector('.nav-link.active');
            if (currentActive) currentActive.classList.remove('active');
            link.classList.add('active');
            const sectionId = link.getAttribute('data-section');
            setActiveSection(sectionId);
        });
    });

    function setActiveSection(sectionId) {
        contentSections.forEach(section => {
            section.classList.remove('active');
        });
        const activeSection = document.getElementById(sectionId);
        if (activeSection) {
            activeSection.classList.add('active');
            const titleText = sectionId.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()); // More robust title
            if (pageTitleElement) pageTitleElement.textContent = titleText;

            if (backButtonContainer) {
                if (sectionId === 'inventory-management' || sectionId === 'recipes-section' || sectionId === 'purchase-orders' || sectionId === 'sales-orders' || sectionId === 'waste-management') {
                     // A more generic back button for sections that are not dashboard
                    if (!document.getElementById('back-to-dashboard-btn')) { // Avoid adding multiple buttons
                        backButtonContainer.innerHTML = `<button class="btn btn-secondary btn-sm" id="back-to-dashboard-btn" title="Go to Dashboard"><i class="fas fa-arrow-left"></i> Back to Dashboard</button>`;
                        document.getElementById('back-to-dashboard-btn').addEventListener('click', () => {
                            setActiveSection('dashboard');
                            navLinks.forEach(navLink => {
                               if(navLink.getAttribute('data-section') === 'dashboard') navLink.classList.add('active');
                               else navLink.classList.remove('active');
                            });
                        });
                    }
                } else {
                    backButtonContainer.innerHTML = '';
                }
            }
        }

        if (sectionId === 'dashboard' && inventoryChartInstance) updateInventoryChart();
        if (sectionId === 'reports') {
            if (consumptionChartInstance) updateConsumptionChart();
            if (inventoryReportChartInstance) updateInventoryReportChart();
            if (wasteChartInstance) updateWasteChart();
        }
         // Ensure tabs are re-initialized if a section with tabs is activated
        if (sectionId === 'purchase-orders') setupTabs('#purchase-orders .tabs');
        if (sectionId === 'reports') setupTabs('#reports .tabs');
    }

    // --- Modal Handling ---
    if (closeModalBtn) {
        closeModalBtn.addEventListener('click', closeGenericModal);
    }
    if (genericModal) {
        genericModal.addEventListener('click', (event) => {
            if (event.target === genericModal) {
                closeGenericModal();
            }
        });
    }

    function openGenericModal(title, formHtml, footerHtml) {
        if (!genericModal || !modalTitle || !modalFormContent || !modalFormFooter) {
            console.error("Generic modal elements not found!");
            showToast("Error: Modal elements missing.", "error");
            return;
        }
        modalTitle.textContent = title;
        modalFormContent.innerHTML = formHtml;
        modalFormFooter.innerHTML = footerHtml;
        genericModal.classList.add('active');

        const firstInput = modalFormContent.querySelector('input:not([type="hidden"]):not([readonly]), select, textarea');
        if (firstInput) {
            setTimeout(() => firstInput.focus(), 50);
        }
    }

    function closeGenericModal() {
        if (genericModal) {
            genericModal.classList.remove('active');
            // modalFormContent.innerHTML = ''; // Optional: Clear content on close
            // modalFormFooter.innerHTML = '';
        }
    }
    window.closeGenericModal = closeGenericModal;

    // --- Confirmation Modal ---
    function openConfirmationModal(title, message, onConfirm, onCancel) {
        const contentHtml = `<p>${message}</p>`;
        const footerHtml = `
            <button type="button" class="btn btn-danger" id="confirmActionBtnModal">Yes, Proceed</button>
            <button type="button" class="btn" id="cancelActionBtnModal">Cancel</button>
        `; // Changed IDs to avoid conflict if modal is reused quickly
        openGenericModal(title, contentHtml, footerHtml);

        const confirmBtn = document.getElementById('confirmActionBtnModal');
        const cancelBtn = document.getElementById('cancelActionBtnModal');

        // Remove previous listeners if any, to prevent multiple executions
        const newConfirmBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
        const newCancelBtn = cancelBtn.cloneNode(true);
        cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);


        newConfirmBtn.addEventListener('click', () => {
            if (onConfirm && typeof onConfirm === 'function') {
                onConfirm();
            }
            closeGenericModal();
        });
        newCancelBtn.addEventListener('click', () => {
            if (onCancel && typeof onCancel === 'function') {
                onCancel();
            }
            closeGenericModal();
        });
    }


    // --- Toast Notifications ---
    function showToast(message, type = 'info', duration = 3000) {
        if (!toastContainer) {
            console.warn("Toast container not found. Message:", message);
            // alert(message); // Fallback for critical messages if toast isn't there, but avoid if possible.
            return;
        }
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `${message} <button class="close-toast" aria-label="Close">&times;</button>`;

        toastContainer.appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 10); // Animation delay

        const closeButton = toast.querySelector('.close-toast');
        closeButton.addEventListener('click', () => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 400); // Allow fade out
        });

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 400); // Allow fade out
        }, duration);
    }


    // --- Tab Functionality ---
  // ==========================================================
// REPLACE this entire function in your script.js
// ==========================================================
function setupTabs(tabContainerSelector) {
    const tabContainers = document.querySelectorAll(tabContainerSelector);
    tabContainers.forEach(container => {
        const tabs = container.querySelectorAll('.tab');
        if (tabs.length === 0) return;

        const tabContentParent = container.closest('.content-section') || document;

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                
                const targetTabContentId = tab.dataset.tab + '-tab';
                const tabContents = tabContentParent.querySelectorAll('.tab-content');
                
                tabContents.forEach(content => {
                    content.classList.remove('active');
                    if (content.id === targetTabContentId) {
                        content.classList.add('active');
                    }
                });

                // THIS IS THE FIX: We call updateAllCharts every time a tab is clicked
                // to ensure the correct chart for the visible tab is drawn.
                updateAllCharts();
            });
        });

        // Activate the first tab by default if none are active
        const activeTab = container.querySelector('.tab.active');
        if (!activeTab && tabs.length > 0) {
            tabs[0].click();
        } else if (activeTab) {
            activeTab.click();
        }
    });
}


    // --- RENDER FUNCTIONS ---
    // These functions now expect their respective global arrays (rawMaterials, recipes, etc.)
    // to be populated by Firestore's onSnapshot listeners.

    function renderMaterialsTable() {
        const tableBody = document.getElementById('materials-table')?.querySelector('tbody');
        if (!tableBody) return;
        tableBody.innerHTML = '';
        if (!rawMaterials || rawMaterials.length === 0) { // Check if array is defined and has items
            tableBody.innerHTML = '<tr><td colspan="8" class="text-center p-4">No raw materials found in storage. Add some!</td></tr>';
        } else {
            rawMaterials.forEach(material => {
                const stock = parseFloat(material.stock) || 0;
                const threshold = parseFloat(material.threshold) || 0;
                const statusClass = stock <= threshold ? 'badge-danger' : (stock <= threshold * 1.2 ? 'badge-warning' : 'badge-success');
                const statusText = stock <= threshold ? 'Low Stock' : (stock <= threshold * 1.2 ? 'Order Soon' : 'In Stock');
                const displayId = `RM-${material.id.substring(0, 5).toUpperCase()}`;
                const row = `
                    <tr class="fade-in">
                        <td>${displayId}</td>
                        <td>${material.name || 'N/A'}</td>
                        <td>${material.stock}</td>
                        <td>${material.unit || 'N/A'}</td>
                        <td>${material.threshold}</td>
                        <td>${material.category || 'N/A'}</td>
                        <td><span class="badge ${statusClass}">${statusText}</span></td>
                        <td>
                            <button class="btn btn-warning btn-sm" onclick="editMaterial('${material.id}')" title="Edit"><i class="fas fa-edit"></i></button>
                            <button class="btn btn-danger btn-sm" onclick="deleteMaterial('${material.id}')" title="Delete"><i class="fas fa-trash"></i></button>
                        </td>
                    </tr>`;
                tableBody.insertAdjacentHTML('beforeend', row);
            });
        }
        renderLowStockTable(); // Always update low stock based on current materials
    }

    function renderLowStockTable() {
        const tableBody = document.getElementById('low-stock-table')?.querySelector('tbody');
        const lowStockCounter = document.getElementById('low-stock-items');
        if (!tableBody || !lowStockCounter) return;

        tableBody.innerHTML = '';
        const lowStockItems = rawMaterials && rawMaterials.length > 0 ? rawMaterials.filter(m => parseFloat(m.stock) <= parseFloat(m.threshold)) : [];
        lowStockCounter.textContent = lowStockItems.length;

        if (lowStockItems.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="6" class="text-center p-4">No low stock items. Good job!</td></tr>';
            return;
        }
        lowStockItems.forEach(material => {
            const displayId = `RM-${material.id.substring(0, 5).toUpperCase()}`;
            const row = `
                <tr class="fade-in">
                    <td>${material.name || 'N/A'} (${displayId})</td>
                    <td>${material.stock}</td>
                    <td>${material.threshold}</td>
                    <td>${material.unit || 'N/A'}</td>
                    <td><span class="badge badge-danger">Needs Reorder</span></td>
                    <td>
                        <button class="btn btn-success btn-sm" onclick="generateSinglePO('${material.id}')" title="Order Now">
                            <i class="fas fa-cart-plus"></i> Order
                        </button>
                    </td>
                </tr>`;
            tableBody.insertAdjacentHTML('beforeend', row);
        });
    }

    function renderRecipesTable() {
        const tableBody = document.getElementById('recipes-table')?.querySelector('tbody');
        if (!tableBody) return;
        tableBody.innerHTML = '';
        if (!recipes || recipes.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="6" class="text-center p-4">No recipes created yet. Add one to get started!</td></tr>';
        } else {
            recipes.forEach(recipe => {
                const ingredientsList = recipe.ingredients && recipe.ingredients.length > 0
                    ? recipe.ingredients.map(ing => {
                        const material = rawMaterials.find(m => m.id === ing.materialId);
                        const unit = material ? material.unit : '';
                        return material ? `${material.name} (${ing.quantity} ${unit})` : `Material ID ${ing.materialId} not found`;
                    }).join('<br>')
                    : 'No ingredients listed';
                const displayId = `REC-${recipe.id.substring(0, 5).toUpperCase()}`;
                const row = `
                    <tr class="fade-in">
                        <td>${displayId}</td>
                        <td>${recipe.name || 'N/A'}</td>
                        <td>${recipe.category || 'N/A'}</td>
                        <td>${ingredientsList}</td>
                        <td>${recipe.portionSize || 'N/A'}</td>
                        <td>
                            <button class="btn btn-info btn-sm" onclick="viewRecipe('${recipe.id}')" title="View"><i class="fas fa-eye"></i></button>
                            <button class="btn btn-warning btn-sm" onclick="editRecipe('${recipe.id}')" title="Edit"><i class="fas fa-edit"></i></button>
                            <button class="btn btn-danger btn-sm" onclick="deleteRecipe('${recipe.id}')" title="Delete"><i class="fas fa-trash"></i></button>
                        </td>
                    </tr>`;
                tableBody.insertAdjacentHTML('beforeend', row);
            });
        }
    }

    function renderPurchaseOrdersTables() {
        const pendingBody = document.getElementById('pending-po-table')?.querySelector('tbody');
        const completedBody = document.getElementById('completed-po-table')?.querySelector('tbody');
        const allBody = document.getElementById('all-po-table')?.querySelector('tbody');
        const pendingCounter = document.getElementById('pending-orders');

        if(pendingBody) pendingBody.innerHTML = '';
        if(completedBody) completedBody.innerHTML = '';
        if(allBody) allBody.innerHTML = '';
        if(pendingCounter) pendingCounter.textContent = '0';


        if (!purchaseOrders || purchaseOrders.length === 0) {
            const noDataMsg = '<tr><td colspan="7" class="text-center p-4">No purchase orders found.</td></tr>';
            if(allBody) allBody.innerHTML = noDataMsg;
            if(pendingBody) pendingBody.innerHTML = noDataMsg.replace('purchase orders found', 'pending purchase orders');
            if(completedBody) completedBody.innerHTML = noDataMsg.replace('purchase orders found', 'completed purchase orders');
            return;
        }

        let pendingCount = 0;
        let completedCount = 0;

        purchaseOrders.forEach(po => {
            const statusBadge = po.status === 'Pending' ? 'badge-warning' : (po.status === 'Completed' ? 'badge-success' : (po.status === 'Cancelled' ? 'badge-danger' : 'badge-info'));
            // Firestore timestamp to JS Date: po.date.toDate()
            const date = po.date ? (po.date.toDate ? po.date.toDate().toLocaleDateString() : new Date(po.date).toLocaleDateString()) : 'N/A';
            const totalAmount = (typeof po.totalAmount === 'number') ? po.totalAmount.toFixed(2) : '0.00';
            const itemsLength = po.items && Array.isArray(po.items) ? po.items.length : 0;

            const rowHtml = `
                <tr class="fade-in">
                    <td>${po.poNumber || `PO-${po.id.substring(0,5).toUpperCase()}`}</td>
                    <td>${po.vendor || 'N/A'}</td>
                    <td>${date}</td>
                    <td>${itemsLength}</td>
                    <td>₹${totalAmount}</td>
                    <td><span class="badge ${statusBadge}">${po.status || 'N/A'}</span></td>
                    <td>
                        <button class="btn btn-info btn-sm" onclick="viewPO('${po.id}')" title="View PO"><i class="fas fa-eye"></i></button>
                        ${po.status === 'Pending' ? `<button class="btn btn-success btn-sm" onclick="markPOReceived('${po.id}')" title="Mark as Received"><i class="fas fa-check-circle"></i></button>` : ''}
                        ${po.status !== 'Completed' && po.status !== 'Cancelled' ? `<button class="btn btn-danger btn-sm" onclick="cancelPO('${po.id}')" title="Cancel PO"><i class="fas fa-times-circle"></i></button>` : ''}
                    </td>
                </tr>`;
            if (allBody) allBody.insertAdjacentHTML('beforeend', rowHtml);
            if (po.status === 'Pending' && pendingBody) {
                pendingBody.insertAdjacentHTML('beforeend', rowHtml);
                pendingCount++;
            } else if (po.status === 'Completed' && completedBody) {
                completedBody.insertAdjacentHTML('beforeend', rowHtml);
                completedCount++;
            }
        });

        if(pendingCounter) pendingCounter.textContent = pendingCount;
        if (pendingBody && pendingCount === 0) pendingBody.innerHTML = '<tr><td colspan="7" class="text-center p-4">No pending purchase orders.</td></tr>';
        if (completedBody && completedCount === 0) completedBody.innerHTML = '<tr><td colspan="7" class="text-center p-4">No completed purchase orders.</td></tr>';
        if (allBody && purchaseOrders.length === 0 && pendingCount === 0 && completedCount === 0) allBody.innerHTML = '<tr><td colspan="7" class="text-center p-4">No purchase orders of any status.</td></tr>';

    }

    function renderSalesOrdersTable() {
        const tableBody = document.getElementById('sales-orders-table')?.querySelector('tbody');
        if (!tableBody) return;
        tableBody.innerHTML = '';

        if (!salesOrders || salesOrders.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="7" class="text-center p-4">No sales orders recorded yet.</td></tr>';
            return;
        }

        salesOrders.forEach(order => {
            const itemsSummary = order.items && order.items.length > 0 ? order.items.map(item => {
                const recipe = recipes.find(r => r.id === item.recipeId);
                return `${recipe ? recipe.name : `Recipe ID ${item.recipeId} not found`} (Qty: ${item.quantity})`;
            }).join('<br>') : 'No items';
            const statusBadge = order.status === 'Pending' ? 'badge-warning' : (order.status === 'Completed' ? 'badge-success' : (order.status === 'Cancelled' ? 'badge-danger' : 'badge-info'));
            const date = order.date ? (order.date.toDate ? order.date.toDate().toLocaleDateString() : new Date(order.date).toLocaleDateString()) : 'N/A';
            const totalAmount = (typeof order.totalAmount === 'number') ? order.totalAmount.toFixed(2) : '0.00';

            const row = `
                <tr class="fade-in">
                    <td>${order.orderId || `SO-${order.id.substring(0,5).toUpperCase()}`}</td>
                    <td>${order.customer || 'N/A'}</td>
                    <td>${date}</td>
                    <td>${itemsSummary}</td>
                    <td>₹${totalAmount}</td>
                    <td><span class="badge ${statusBadge}">${order.status || 'N/A'}</span></td>
                    <td>
                        <button class="btn btn-info btn-sm" onclick="viewSalesOrder('${order.id}')" title="View"><i class="fas fa-eye"></i></button>
                        ${order.status === 'Pending' ? `<button class="btn btn-success btn-sm" onclick="completeSalesOrder('${order.id}')" title="Complete"><i class="fas fa-check"></i></button>` : ''}
                        ${order.status === 'Pending' ? `<button class="btn btn-danger btn-sm" onclick="cancelSalesOrder('${order.id}')" title="Cancel"><i class="fas fa-times"></i></button>` : ''}
                    </td>
                </tr>`;
            tableBody.insertAdjacentHTML('beforeend', row);
        });
    }

    function renderWasteTable() {
        const tableBody = document.getElementById('waste-table')?.querySelector('tbody');
        if (!tableBody) return;
        tableBody.innerHTML = '';
         if (!wasteRecords || wasteRecords.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="7" class="text-center p-4">No waste records logged.</td></tr>';
            return;
        }
        wasteRecords.forEach((record) => {
            const material = rawMaterials.find(m => m.id === record.materialId);
            const date = record.date ? (record.date.toDate ? record.date.toDate().toLocaleDateString() : new Date(record.date).toLocaleDateString()) : 'N/A';
            const row = `
                <tr class="fade-in">
                    <td>${date}</td>
                    <td>${material ? material.name : `Material ID ${record.materialId} not found`}</td>
                    <td>${record.quantity}</td>
                    <td>${material ? material.unit : 'N/A'}</td>
                    <td>${record.reason || 'N/A'}</td>
                    <td>${record.recordedBy || 'N/A'}</td>
                    <td>
                        <button class="btn btn-warning btn-sm" onclick="editWasteRecord('${record.id}')" title="Edit"><i class="fas fa-edit"></i></button>
                        <button class="btn btn-danger btn-sm" onclick="deleteWasteRecord('${record.id}')" title="Delete"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>`;
            tableBody.insertAdjacentHTML('beforeend', row);
        });
    }

    function renderAllTables() {
        renderMaterialsTable(); // This will also call renderLowStockTable
        renderRecipesTable();
        renderPurchaseOrdersTables();
        renderSalesOrdersTable();
        renderWasteTable();
    }

    // --- DASHBOARD UPDATES ---
    function updateDashboardCards() {
        // Ensure elements exist before trying to update them
        const totalMaterialsEl = document.getElementById('total-materials');
        const activeRecipesEl = document.getElementById('active-recipes');

        if(totalMaterialsEl) totalMaterialsEl.textContent = rawMaterials ? rawMaterials.length : 0;
        if(activeRecipesEl) activeRecipesEl.textContent = recipes ? recipes.length : 0;

        // Low stock and pending orders are updated by their respective render functions,
        // but we can call them here to ensure dashboard is fresh if data changes not via table renders.
        renderLowStockTable();
        renderPurchaseOrdersTables();
    }

    // --- CRUD Operations & Modal Forms (Interacting with Firestore) ---

    // RAW MATERIALS
    document.getElementById('add-material-btn')?.addEventListener('click', () => {
        const formHtml = `
            <input type="hidden" id="materialIdModal" value="">
            <div class="form-group"><label for="materialNameModal" class="form-label">Material Name</label><input type="text" id="materialNameModal" class="form-control" required></div>
            <div class="form-group"><label for="materialStockModal" class="form-label">Current Stock</label><input type="number" id="materialStockModal" class="form-control" required min="0" step="any"></div>
            <div class="form-group"><label for="materialUnitModal" class="form-label">Unit (e.g., kg, pcs)</label><input type="text" id="materialUnitModal" class="form-control" required></div>
            <div class="form-group"><label for="materialThresholdModal" class="form-label">Low Stock Threshold</label><input type="number" id="materialThresholdModal" class="form-control" required min="0" step="any"></div>
            <div class="form-group"><label for="materialCategoryModal" class="form-label">Category</label><input type="text" id="materialCategoryModal" class="form-control"></div>
            <div class="form-group"><label for="materialCostPerUnitModal" class="form-label">Cost per Unit (₹)</label><input type="number" id="materialCostPerUnitModal" class="form-control" min="0" step="0.01"></div>
        `; // Added 'Modal' suffix to IDs to avoid clashes if page has similar IDs
        const footerHtml = `
            <button type="button" class="btn btn-primary" id="saveMaterialBtnModal">Save Material</button>
            <button type="button" class="btn" onclick="closeGenericModal()">Cancel</button>
        `;
        openGenericModal("Add New Raw Material", formHtml, footerHtml);
        document.getElementById('saveMaterialBtnModal').addEventListener('click', saveMaterial);
    });

    window.editMaterial = function(id) { // id is Firestore document ID
        const material = rawMaterials.find(m => m.id === id);
        if (!material) { showToast("Material not found for editing.", "error"); return; }

        const formHtml = `
            <input type="hidden" id="materialIdModal" value="${material.id}">
            <div class="form-group"><label for="materialNameModal" class="form-label">Material Name</label><input type="text" id="materialNameModal" class="form-control" value="${material.name}" required></div>
            <div class="form-group"><label for="materialStockModal" class="form-label">Current Stock</label><input type="number" id="materialStockModal" class="form-control" value="${material.stock}" required min="0" step="any"></div>
            <div class="form-group"><label for="materialUnitModal" class="form-label">Unit</label><input type="text" id="materialUnitModal" class="form-control" value="${material.unit}" required></div>
            <div class="form-group"><label for="materialThresholdModal" class="form-label">Low Stock Threshold</label><input type="number" id="materialThresholdModal" class="form-control" value="${material.threshold}" required min="0" step="any"></div>
            <div class="form-group"><label for="materialCategoryModal" class="form-label">Category</label><input type="text" id="materialCategoryModal" class="form-control" value="${material.category || ''}"></div>
            <div class="form-group"><label for="materialCostPerUnitModal" class="form-label">Cost per Unit (₹)</label><input type="number" id="materialCostPerUnitModal" class="form-control" value="${material.costPerUnit || 0}" min="0" step="0.01"></div>
        `;
        const footerHtml = `
            <button type="button" class="btn btn-primary" id="saveMaterialBtnModal">Update Material</button>
            <button type="button" class="btn" onclick="closeGenericModal()">Cancel</button>
        `;
        openGenericModal("Edit Raw Material", formHtml, footerHtml);
        // Ensure event listener is attached to the new button instance
        const saveBtn = document.getElementById('saveMaterialBtnModal');
        if(saveBtn) saveBtn.addEventListener('click', saveMaterial); else console.error("Save button not found in modal for edit material")

    }

    async function saveMaterial() {
        if (!isAuthReady || !userId) {
            showToast("Error: Not authenticated. Cannot save material.", "error");
            return;
        }
        const id = document.getElementById('materialIdModal').value;
        const name = document.getElementById('materialNameModal').value.trim();
        const stock = parseFloat(document.getElementById('materialStockModal').value);
        const unit = document.getElementById('materialUnitModal').value.trim();
        const threshold = parseFloat(document.getElementById('materialThresholdModal').value);
        const category = document.getElementById('materialCategoryModal').value.trim();
        const costPerUnit = parseFloat(document.getElementById('materialCostPerUnitModal').value) || 0;

        if (!name || isNaN(stock) || !unit || isNaN(threshold) || stock < 0 || threshold < 0) { // Added validation for negative values
            showToast("Please fill all required fields correctly (stock/threshold cannot be negative).", "error");
            return;
        }

        const materialData = {
            name, stock, unit, threshold, category, costPerUnit,
            status: stock <= threshold ? 'Low Stock' : (stock <= threshold * 1.2 ? 'Order Soon' : 'In Stock'),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp() // For both add and update
        };

        const materialsRef = getCollectionRef('rawMaterials');
        if (!materialsRef) {
            showToast("Error: Material storage location not found.", "error");
            return;
        }

        try {
            if (id) { // Editing existing material (ID is Firestore doc ID)
                await materialsRef.doc(id).update(materialData);
                showToast("Raw material updated successfully!", "success");
            } else { // Adding new material
                materialData.createdAt = firebase.firestore.FieldValue.serverTimestamp();
                await materialsRef.add(materialData); // Firestore generates ID
                showToast("Raw material added successfully!", "success");
            }
            // Data re-renders via onSnapshot listener. No need for explicit render calls here.
            closeGenericModal();
        } catch (error) {
            console.error("Error saving material:", error);
            showToast("Error saving material: " + error.message, "error");
        }
    }

    window.deleteMaterial = async function(id) { // id is Firestore document ID
        if (!isAuthReady || !userId) {
            showToast("Error: Not authenticated. Cannot delete material.", "error");
            return;
        }
        const materialToDelete = rawMaterials.find(m => m.id === id);
        if (!materialToDelete) {
             showToast("Error: Material not found for deletion.", "error");
             return;
        }

        const isUsedInRecipe = recipes.some(recipe => recipe.ingredients && recipe.ingredients.some(ing => ing.materialId === id));
        if (isUsedInRecipe) {
            showToast("Cannot delete: Material is used in recipes. Please remove from recipes first.", "error");
            return;
        }
        // Add similar checks for POs, SOs, Waste if direct material links are problematic for deletion

        openConfirmationModal(
            "Confirm Deletion",
            `Are you sure you want to delete material "${materialToDelete.name}"? This action cannot be undone.`,
            async () => {
                const materialsRef = getCollectionRef('rawMaterials');
                if (!materialsRef) return;
                try {
                    await materialsRef.doc(id).delete();
                    showToast(`Raw material "${materialToDelete.name}" deleted.`, "info");
                    // Data re-renders via onSnapshot
                } catch (error) {
                    console.error("Error deleting material:", error);
                    showToast("Error deleting material: " + error.message, "error");
                }
            }
        );
    };

    // RECIPES
    document.getElementById('add-recipe-btn')?.addEventListener('click', () => editRecipe(null)); // null id for new recipe

    window.editRecipe = function(id) { // id is Firestore doc ID or null for new
        const isNew = id === null;
        const recipe = isNew ? { ingredients: [] } : recipes.find(r => r.id === id); // Ensure ingredients is an array for new
        if (!isNew && !recipe) { showToast("Recipe not found for editing.", "error"); return; }

        let ingredientOptionsHtml = rawMaterials.length > 0
            ? rawMaterials.map(mat => `<option value="${mat.id}">${mat.name} (${mat.unit})</option>`).join('')
            : '<option value="">No raw materials available</option>';

        const currentIngredients = recipe.ingredients || []; // Ensure it's an array

        const formHtml = `
            <input type="hidden" id="recipeIdModal" value="${isNew ? '' : recipe.id}">
            <div class="form-group"><label for="recipeNameModal" class="form-label">Recipe Name</label><input type="text" id="recipeNameModal" class="form-control" value="${isNew ? '' : recipe.name}" required></div>
            <div class="form-group"><label for="recipeCategoryModal" class="form-label">Category</label><input type="text" id="recipeCategoryModal" class="form-control" value="${isNew ? '' : (recipe.category || '')}"></div>
            <div class="form-group"><label for="recipePortionSizeModal" class="form-label">Portion Size</label><input type="text" id="recipePortionSizeModal" class="form-control" value="${isNew ? '' : (recipe.portionSize || '')}" placeholder="e.g., 1 serving, 200g"></div>
            <div class="form-group"><label for="recipePriceModal" class="form-label">Selling Price (₹)</label><input type="number" id="recipePriceModal" class="form-control" value="${isNew ? '' : (recipe.price || 0)}" min="0" step="0.01"></div>
            <hr>
            <h5>Ingredients</h5>
            <div id="ingredients-container-modal">
                ${currentIngredients.map(ing => {
                    // Find the material to pre-select
                    const materialExists = rawMaterials.some(m => m.id === ing.materialId);
                    return `
                    <div class="ingredient-item">
                        <select class="form-control ingredient-material-modal" required>
                            ${materialExists ? rawMaterials.map(mat => `<option value="${mat.id}" ${ing.materialId === mat.id ? 'selected' : ''}>${mat.name} (${mat.unit})</option>`).join('') : `<option value="">Material not found</option>`}
                        </select>
                        <input type="number" class="form-control ingredient-quantity-modal" value="${ing.quantity}" placeholder="Qty" min="0.01" step="any" required>
                        <span class="remove-ingredient-modal" title="Remove Ingredient"><i class="fas fa-times-circle text-danger"></i></span>
                    </div>`;
                    }).join('')
                }
            </div>
            <button type="button" class="btn btn-sm btn-success mt-2" id="addRecipeIngredientBtnModal"><i class="fas fa-plus"></i> Add Ingredient</button>
        `;
        const footerHtml = `
            <button type="button" class="btn btn-primary" id="saveRecipeBtnModal">${isNew ? 'Save Recipe' : 'Update Recipe'}</button>
            <button type="button" class="btn" onclick="closeGenericModal()">Cancel</button>
        `;
        openGenericModal(isNew ? "Add New Recipe" : "Edit Recipe", formHtml, footerHtml);

        const ingredientsContainer = document.getElementById('ingredients-container-modal');

        function addIngredientFieldHtml() {
            const div = document.createElement('div');
            div.className = 'ingredient-item fade-in d-flex align-items-center mb-2'; // Bootstrap flex for alignment
            div.innerHTML = `
                <select class="form-control ingredient-material-modal mr-2 flex-grow-1" required>${ingredientOptionsHtml}</select>
                <input type="number" class="form-control ingredient-quantity-modal mr-2" style="max-width: 100px;" placeholder="Qty" min="0.01" step="any" required>
                <span class="remove-ingredient-modal" title="Remove Ingredient" style="cursor:pointer;"><i class="fas fa-times-circle text-danger"></i></span>
            `;
            ingredientsContainer.appendChild(div);
            div.querySelector('.remove-ingredient-modal').addEventListener('click', () => div.remove());
        }

        document.getElementById('addRecipeIngredientBtnModal').addEventListener('click', addIngredientFieldHtml);
        if (isNew || currentIngredients.length === 0) {
            if (rawMaterials.length > 0) addIngredientFieldHtml(); // Only add if materials exist
            else showToast("Add raw materials first to create ingredients for a recipe.", "warning", 4000);
        } else {
            ingredientsContainer.querySelectorAll('.remove-ingredient-modal').forEach(btn => {
                btn.addEventListener('click', () => btn.closest('.ingredient-item').remove());
            });
        }
        document.getElementById('saveRecipeBtnModal').addEventListener('click', saveRecipe);
    };

    async function saveRecipe() {
        if (!isAuthReady || !userId) {
            showToast("Error: Not authenticated. Cannot save recipe.", "error");
            return;
        }
        const id = document.getElementById('recipeIdModal').value;
        const name = document.getElementById('recipeNameModal').value.trim();
        const category = document.getElementById('recipeCategoryModal').value.trim();
        const portionSize = document.getElementById('recipePortionSizeModal').value.trim();
        const price = parseFloat(document.getElementById('recipePriceModal').value) || 0;

        if (!name) {
            showToast("Recipe name is required.", "error");
            return;
        }
        if (price < 0) {
            showToast("Recipe price cannot be negative.", "error"); return;
        }


        const ingredients = [];
        const ingredientItems = document.querySelectorAll('#ingredients-container-modal .ingredient-item');
        let ingredientsValid = true;
        if (ingredientItems.length === 0 && name) { // Allow saving recipe with no ingredients initially
             // showToast("A recipe should have at least one ingredient.", "warning");
             // ingredientsValid = false; // Uncomment if ingredients are mandatory from start
        }

        ingredientItems.forEach(item => {
            const materialId = item.querySelector('.ingredient-material-modal').value;
            const quantity = parseFloat(item.querySelector('.ingredient-quantity-modal').value);
            if (!materialId || isNaN(quantity) || quantity <= 0) {
                ingredientsValid = false;
            }
            ingredients.push({ materialId, quantity });
        });

        if (!ingredientsValid && ingredientItems.length > 0) { // Only error if items are present but invalid
            showToast("Please ensure all ingredients have a selected material and quantity greater than 0.", "error");
            return;
        }

        const recipeData = {
            name, category, portionSize, price, ingredients,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        const recipesRef = getCollectionRef('recipes');
        if (!recipesRef) { showToast("Error: Recipe storage not found.", "error"); return; }

        try {
            if (id) { // Editing existing
                await recipesRef.doc(id).update(recipeData);
                showToast("Recipe updated successfully!", "success");
            } else { // Adding new
                recipeData.createdAt = firebase.firestore.FieldValue.serverTimestamp();
                await recipesRef.add(recipeData);
                showToast("Recipe added successfully!", "success");
            }
            closeGenericModal();
            // Data re-renders via onSnapshot
        } catch (error) {
            console.error("Error saving recipe:", error);
            showToast("Error saving recipe: " + error.message, "error");
        }
    }

    window.deleteRecipe = async function(id) { // id is Firestore document ID
        if (!isAuthReady || !userId) {
            showToast("Error: Not authenticated. Cannot delete recipe.", "error");
            return;
        }
        const recipeToDelete = recipes.find(r => r.id === id);
        if (!recipeToDelete) {
            showToast("Error: Recipe not found for deletion.", "error");
            return;
        }
        // Check if recipe is used in Sales Orders
        const isUsedInSalesOrder = salesOrders.some(so => so.items && so.items.some(item => item.recipeId === id));
        if (isUsedInSalesOrder) {
            showToast("Cannot delete: Recipe is used in one or more sales orders. Please remove or update sales orders first.", "error", 5000);
            return;
        }

        openConfirmationModal(
            "Confirm Deletion",
            `Are you sure you want to delete recipe "${recipeToDelete.name}"? This action cannot be undone.`,
            async () => {
                const recipesRef = getCollectionRef('recipes');
                if (!recipesRef) return;
                try {
                    await recipesRef.doc(id).delete();
                    showToast(`Recipe "${recipeToDelete.name}" deleted.`, "info");
                    // Data re-renders via onSnapshot
                } catch (error) {
                    console.error("Error deleting recipe:", error);
                    showToast("Error deleting recipe: " + error.message, "error");
                }
            }
        );
    };

    window.viewRecipe = function(id) { // id is Firestore document ID
        const recipe = recipes.find(r => r.id === id);
        if (!recipe) {
            showToast("Recipe not found.", "error");
            return;
        }
        const ingredientsList = recipe.ingredients && recipe.ingredients.length > 0
            ? recipe.ingredients.map(ing => {
                const material = rawMaterials.find(m => m.id === ing.materialId);
                return `<li>${material ? material.name : `Material ID ${ing.materialId} not found`}: ${ing.quantity} ${material ? material.unit : ''}</li>`;
            }).join('')
            : '<li>No ingredients listed for this recipe.</li>';

        const contentHtml = `
            <h4>${recipe.name}</h4>
            <p><strong>Category:</strong> ${recipe.category || 'N/A'}</p>
            <p><strong>Portion Size:</strong> ${recipe.portionSize || 'N/A'}</p>
            <p><strong>Selling Price:</strong> ₹${(recipe.price || 0).toFixed(2)}</p>
            <h5>Ingredients:</h5>
            <ul>${ingredientsList}</ul>
        `;
        const footerHtml = `<button type="button" class="btn" onclick="closeGenericModal()">Close</button>`;
        openGenericModal(`View Recipe: ${recipe.name}`, contentHtml, footerHtml);
    };


    // PURCHASE ORDERS
    document.getElementById('add-po-btn')?.addEventListener('click', () => editPO(null));

    window.editPO = function(id) { // id is Firestore doc ID or null
        const isNew = id === null;
        const po = isNew ? { items: [] } : purchaseOrders.find(p => p.id === id);
        if (!isNew && !po) { showToast("Purchase Order not found.", "error"); return; }

        const materialOptionsHtml = rawMaterials.length > 0
            ? rawMaterials.map(mat => `<option value="${mat.id}" data-cost="${mat.costPerUnit || 0}">${mat.name} (${mat.unit})</option>`).join('')
            : '<option value="">No raw materials defined</option>';

        const currentPOItems = po.items || [];
        const defaultPONumber = `PO${new Date().getFullYear()}${(purchaseOrders.length + 1).toString().padStart(3,'0')}${Math.random().toString(36).substr(2, 3).toUpperCase()}`;


        const formHtml = `
            <input type="hidden" id="poIdModal" value="${isNew ? '' : po.id}">
            <div class="form-group">
                <label for="poNumberModal" class="form-label">PO Number</label>
                <input type="text" id="poNumberModal" class="form-control" value="${isNew ? defaultPONumber : po.poNumber}" ${isNew ? '' : 'readonly'}>
            </div>
            <div class="form-group">
                <label for="poVendorModal" class="form-label">Vendor</label>
                <input type="text" id="poVendorModal" class="form-control" value="${isNew ? '' : po.vendor}" required>
            </div>
            <div class="form-group">
                <label for="poDateModal" class="form-label">Date</label>
                <input type="date" id="poDateModal" class="form-control" value="${isNew ? new Date().toISOString().split('T')[0] : (po.date && po.date.toDate ? po.date.toDate().toISOString().split('T')[0] : new Date().toISOString().split('T')[0])}" required>
            </div>
            <hr>
            <h5>Items</h5>
            <div id="po-items-container-modal">
                ${currentPOItems.map(item => {
                    const material = rawMaterials.find(m => m.id === item.materialId);
                    return `
                    <div class="po-item d-flex align-items-center mb-2">
                        <select class="form-control po-item-material-modal mr-2 flex-grow-1" required>
                            ${rawMaterials.map(mat => `<option value="${mat.id}" data-cost="${mat.costPerUnit || 0}" ${item.materialId === mat.id ? 'selected' : ''}>${mat.name} (${mat.unit})</option>`).join('')}
                        </select>
                        <input type="number" class="form-control po-item-quantity-modal mr-2" style="max-width: 100px;" value="${item.quantity}" placeholder="Qty" min="1" step="1" required>
                        <input type="number" class="form-control po-item-price-modal" style="max-width: 120px;" value="${item.price || (material ? material.costPerUnit : 0) || 0}" placeholder="Price/Unit" min="0" step="0.01" required>
                        <span class="remove-po-item-modal ml-2" title="Remove Item" style="cursor:pointer;"><i class="fas fa-times-circle text-danger"></i></span>
                    </div>`;
                }).join('')}
            </div>
            <button type="button" class="btn btn-sm btn-success mt-2" id="addPOItemBtnModal"><i class="fas fa-plus"></i> Add Item</button>
            <div class="form-group mt-3">
                <label for="poTotalAmountModal" class="form-label">Total Amount (₹)</label>
                <input type="text" id="poTotalAmountModal" class="form-control" value="${isNew ? '0.00' : (po.totalAmount || 0).toFixed(2)}" readonly>
            </div>
             <div class="form-group">
                <label for="poStatusModal" class="form-label">Status</label>
                <select id="poStatusModal" class="form-control">
                    <option value="Pending" ${isNew || (po && po.status === 'Pending') ? 'selected' : ''}>Pending</option>
                    <option value="Completed" ${po && po.status === 'Completed' ? 'selected' : ''}>Completed</option>
                    <option value="Cancelled" ${po && po.status === 'Cancelled' ? 'selected' : ''}>Cancelled</option>
                </select>
            </div>
        `;
        const footerHtml = `<button type="button" class="btn btn-primary" id="savePOBtnModal">${isNew ? 'Create PO' : 'Update PO'}</button> <button type="button" class="btn" onclick="closeGenericModal()">Cancel</button>`;
        openGenericModal(isNew ? "Create Purchase Order" : "Edit Purchase Order", formHtml, footerHtml);

        const poItemsContainer = document.getElementById('po-items-container-modal');

        function addPOItemFieldHtml() {
            const div = document.createElement('div');
            div.className = 'po-item d-flex align-items-center mb-2 fade-in';
            const initialMaterialCost = rawMaterials.length > 0 ? (rawMaterials[0].costPerUnit || 0) : 0;
            div.innerHTML = `
                <select class="form-control po-item-material-modal mr-2 flex-grow-1" required>${materialOptionsHtml}</select>
                <input type="number" class="form-control po-item-quantity-modal mr-2" style="max-width: 100px;" value="1" placeholder="Qty" min="1" step="1" required>
                <input type="number" class="form-control po-item-price-modal" style="max-width: 120px;" value="${initialMaterialCost}" placeholder="Price/Unit" min="0" step="0.01" required>
                <span class="remove-po-item-modal ml-2" title="Remove Item" style="cursor:pointer;"><i class="fas fa-times-circle text-danger"></i></span>
            `;
            poItemsContainer.appendChild(div);
            div.querySelector('.remove-po-item-modal').addEventListener('click', () => { div.remove(); updatePOTotalModal(); });
            div.querySelector('.po-item-material-modal').addEventListener('change', (e) => {
                const selectedOption = e.target.options[e.target.selectedIndex];
                const cost = selectedOption.dataset.cost;
                div.querySelector('.po-item-price-modal').value = cost || 0;
                updatePOTotalModal();
            });
            div.querySelectorAll('.po-item-quantity-modal, .po-item-price-modal').forEach(input => {
                input.addEventListener('input', updatePOTotalModal);
            });
        }

        function updatePOTotalModal() {
            let total = 0;
            poItemsContainer.querySelectorAll('.po-item').forEach(item => {
                const qty = parseFloat(item.querySelector('.po-item-quantity-modal').value) || 0;
                const price = parseFloat(item.querySelector('.po-item-price-modal').value) || 0;
                total += qty * price;
            });
            const totalAmountEl = document.getElementById('poTotalAmountModal');
            if (totalAmountEl) totalAmountEl.value = total.toFixed(2);
        }

        document.getElementById('addPOItemBtnModal').addEventListener('click', addPOItemFieldHtml);
        if (isNew || currentPOItems.length === 0) {
             if (rawMaterials.length > 0) addPOItemFieldHtml();
             else showToast("Please add raw materials before creating PO items.", "warning", 4000);
        } else {
             poItemsContainer.querySelectorAll('.remove-po-item-modal').forEach(btn => {
                btn.addEventListener('click', () => { btn.closest('.po-item').remove(); updatePOTotalModal(); });
            });
            poItemsContainer.querySelectorAll('.po-item-material-modal').forEach(select => {
                select.addEventListener('change', (e) => {
                    const selectedOption = e.target.options[e.target.selectedIndex];
                    const cost = selectedOption.dataset.cost;
                    select.closest('.po-item').querySelector('.po-item-price-modal').value = cost || 0;
                    updatePOTotalModal();
                });
            });
            poItemsContainer.querySelectorAll('.po-item-quantity-modal, .po-item-price-modal').forEach(input => {
                input.addEventListener('input', updatePOTotalModal);
            });
        }
        updatePOTotalModal(); // Initial calculation

        document.getElementById('savePOBtnModal').addEventListener('click', savePO);
    };

    async function savePO() {
        if (!isAuthReady || !userId) { showToast("Not authenticated. Cannot save PO.", "error"); return; }

        const id = document.getElementById('poIdModal').value;
        const poNumber = document.getElementById('poNumberModal').value.trim();
        const vendor = document.getElementById('poVendorModal').value.trim();
        const dateStr = document.getElementById('poDateModal').value;
        const status = document.getElementById('poStatusModal').value;

        if (!poNumber || !vendor || !dateStr) { showToast("PO Number, Vendor, and Date are required.", "error"); return; }
        if (!status) { showToast("PO Status is required.", "error"); return;}


        const date = firebase.firestore.Timestamp.fromDate(new Date(dateStr)); // Convert to Firestore Timestamp

        const items = [];
        let itemsValid = true;
        document.querySelectorAll('#po-items-container-modal .po-item').forEach(itemEl => {
            const materialId = itemEl.querySelector('.po-item-material-modal').value;
            const quantity = parseFloat(itemEl.querySelector('.po-item-quantity-modal').value);
            const price = parseFloat(itemEl.querySelector('.po-item-price-modal').value);
            if (!materialId || isNaN(quantity) || quantity <= 0 || isNaN(price) || price < 0) {
                itemsValid = false;
            }
            items.push({ materialId, quantity, price });
        });

        if (!itemsValid || items.length === 0) { showToast("Please add valid items (material, quantity > 0, price >= 0) to the PO.", "error"); return; }

        const totalAmount = parseFloat(document.getElementById('poTotalAmountModal').value);
        if (isNaN(totalAmount) || totalAmount < 0) {
            showToast("Total amount calculation error or negative. Please check item prices and quantities.", "error"); return;
        }


        const poData = {
            poNumber, vendor, date, items, totalAmount, status,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        const poRef = getCollectionRef('purchaseOrders');
        if (!poRef) { showToast("Error: PO storage not found.", "error"); return; }

        try {
            if (id) { // Update existing PO
                await poRef.doc(id).update(poData);
                showToast("Purchase Order updated successfully!", "success");
            } else { // Create new PO
                poData.createdAt = firebase.firestore.FieldValue.serverTimestamp();
                await poRef.add(poData);
                showToast("Purchase Order created successfully!", "success");
            }
            closeGenericModal();
            // Real-time listener will update the table.
        } catch (error) {
            console.error("Error saving PO:", error);
            showToast("Error saving PO: " + error.message, "error");
        }
    }

    window.markPOReceived = async function(id) { // id is Firestore document ID
        if (!isAuthReady || !userId) { showToast("Not authenticated.", "error"); return; }
        const po = purchaseOrders.find(p => p.id === id);
        if (!po) { showToast("PO not found.", "error"); return; }
        if (po.status === 'Completed') { showToast(`PO ${po.poNumber || id} is already completed.`, "info"); return; }
        if (po.status === 'Cancelled') { showToast(`PO ${po.poNumber || id} is cancelled and cannot be marked as received.`, "warning"); return; }


        openConfirmationModal("Mark PO as Received", `This will mark PO ${po.poNumber || id} as 'Completed' and update material stock levels. Proceed?`, async () => {
            const poDocRef = getCollectionRef('purchaseOrders').doc(id);
            const batch = db.batch(); // Firestore batch write

            try {
                // Update stock for each item in the PO
                let allMaterialsExist = true;
                for (const item of po.items) {
                    const materialDocRef = getCollectionRef('rawMaterials').doc(item.materialId);
                    // It's good practice to ensure material exists, though `update` would fail if not.
                    // For this operation, we assume material exists as it was selected for the PO.
                    batch.update(materialDocRef, {
                        stock: firebase.firestore.FieldValue.increment(item.quantity)
                        // Optionally, update material status if it changes due to increased stock
                    });
                }

                // Update PO status to 'Completed'
                batch.update(poDocRef, {
                    status: 'Completed',
                    receivedAt: firebase.firestore.FieldValue.serverTimestamp(), // Add a received timestamp
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });

                await batch.commit();
                showToast(`PO ${po.poNumber || id} marked as received. Stock updated.`, "success");
                // Real-time listeners will update tables and dashboard.
            } catch (error) {
                console.error("Error marking PO received:", error);
                showToast("Error processing PO reception: " + error.message, "error");
            }
        });
    };

    window.cancelPO = async function(id) { // id is Firestore document ID
        if (!isAuthReady || !userId) { showToast("Not authenticated.", "error"); return; }
        const po = purchaseOrders.find(p => p.id === id);
        if (!po) { showToast("PO not found.", "error"); return; }
        if (po.status === 'Completed' || po.status === 'Cancelled') {
            showToast(`PO ${po.poNumber || id} is already ${po.status.toLowerCase()} and cannot be cancelled again.`, "info");
            return;
        }

        openConfirmationModal("Cancel Purchase Order", `Are you sure you want to cancel PO ${po.poNumber || id}? This action cannot be undone.`, async () => {
            const poDocRef = getCollectionRef('purchaseOrders').doc(id);
            try {
                await poDocRef.update({
                    status: 'Cancelled',
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                showToast(`PO ${po.poNumber || id} has been cancelled.`, "info");
                // Real-time listeners update UI.
            } catch (error) {
                console.error("Error cancelling PO:", error);
                showToast("Error cancelling PO: " + error.message, "error");
            }
        });
    };

    window.viewPO = function(id) { // id is Firestore document ID
        const po = purchaseOrders.find(p => p.id === id);
        if (!po) { showToast("PO not found.", "error"); return; }

        const itemsHtml = po.items && po.items.length > 0 ? po.items.map(item => {
            const material = rawMaterials.find(m => m.id === item.materialId);
            const itemPrice = typeof item.price === 'number' ? item.price.toFixed(2) : 'N/A';
            const itemTotal = (typeof item.quantity === 'number' && typeof item.price === 'number') ? (item.quantity * item.price).toFixed(2) : 'N/A';
            return `<li>${material ? material.name : `Material ID ${item.materialId} not found`}: ${item.quantity} x ₹${itemPrice} = ₹${itemTotal}</li>`;
        }).join('') : '<li>No items in this PO.</li>';

        const date = po.date ? (po.date.toDate ? po.date.toDate().toLocaleDateString() : new Date(po.date).toLocaleDateString()) : 'N/A';
        const statusBadge = po.status === 'Pending' ? 'badge-warning' : (po.status === 'Completed' ? 'badge-success' : (po.status === 'Cancelled' ? 'badge-danger' : 'badge-info'));

        const contentHtml = `
            <h4>PO: ${po.poNumber || `PO-${po.id.substring(0,5).toUpperCase()}`}</h4>
            <p><strong>Vendor:</strong> ${po.vendor || 'N/A'}</p>
            <p><strong>Date:</strong> ${date}</p>
            <p><strong>Status:</strong> <span class="badge ${statusBadge}">${po.status || 'N/A'}</span></p>
            <h5>Items:</h5>
            <ul>${itemsHtml}</ul>
            <p><strong>Total Amount: ₹${(po.totalAmount || 0).toFixed(2)}</strong></p>
            ${po.receivedAt ? `<p><em>Received on: ${po.receivedAt.toDate().toLocaleString()}</em></p>` : ''}
        `;
        const footerHtml = `<button type="button" class="btn" onclick="closeGenericModal()">Close</button>`;
        openGenericModal(`View Purchase Order: ${po.poNumber || po.id}`, contentHtml, footerHtml);
    };

    window.generateSinglePO = function(materialId) {
        const material = rawMaterials.find(m => m.id === materialId);
        if (!material) {
            showToast("Material not found for PO generation.", "error");
            return;
        }
        setActiveSection('purchase-orders'); // Navigate to PO section
        // Ensure the 'All POs' or a relevant tab is active if using tabs within PO section
        const poTabsContainer = document.querySelector('#purchase-orders .tabs');
        if (poTabsContainer) {
            // Attempt to click the tab that shows the "Add PO" button or where new POs are managed
            const addPOTab = poTabsContainer.querySelector('.tab[data-tab="all-po"]'); // Or whichever tab is appropriate
            if (addPOTab) addPOTab.click();
        }

        editPO(null); // Open the new PO modal

        // After modal opens, attempt to pre-fill with the selected material
        setTimeout(() => {
            const itemsContainer = document.getElementById('po-items-container-modal');
            if (itemsContainer && itemsContainer.firstChild) { // Assuming addPOItemFieldHtml was called
                const firstItemRow = itemsContainer.querySelector('.po-item');
                if (firstItemRow) {
                    const materialSelect = firstItemRow.querySelector('.po-item-material-modal');
                    const quantityInput = firstItemRow.querySelector('.po-item-quantity-modal');
                    const priceInput = firstItemRow.querySelector('.po-item-price-modal');

                    if (materialSelect) {
                        materialSelect.value = materialId;
                        // Trigger change to update price if linked
                        materialSelect.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    if (quantityInput) {
                        // Calculate a suggested reorder quantity, e.g., to reach threshold + a buffer, or just a default
                        const reorderQty = Math.max(1, Math.ceil((parseFloat(material.threshold) || 0) - (parseFloat(material.stock) || 0) + (parseFloat(material.threshold) * 0.2 || 5))); // Threshold - Stock + 20% buffer or 5 units
                        quantityInput.value = reorderQty > 0 ? reorderQty : 10; // Default to 10 if calculation is zero or negative
                    }
                     if (priceInput && material.costPerUnit) {
                        priceInput.value = material.costPerUnit;
                    }


                    // Manually trigger update of total amount
                    if (typeof updatePOTotalModal === 'function') {
                        updatePOTotalModal();
                    }
                }
            }
            showToast(`PO form opened. '${material.name}' added for review.`, "info", 5000);
        }, 600); // Increased delay slightly to ensure modal and its dynamic content are fully ready
    };


    // SALES ORDERS
    document.getElementById('add-so-btn')?.addEventListener('click', () => editSO(null));
    // let nextSalesOrderIdSuffix = 1; // Already defined globally, managed by SO array length for default ID

    window.editSO = function(id) { // id is Firestore doc ID or null
        const isNew = id === null;
        const so = isNew ? { items: [] } : salesOrders.find(s => s.id === id);
        if (!isNew && !so) { showToast("Sales Order not found.", "error"); return; }

        const recipeOptionsHtml = recipes.length > 0
            ? recipes.map(rec => `<option value="${rec.id}" data-price="${rec.price || 0}">${rec.name}</option>`).join('')
            : '<option value="">No recipes available</option>';

        const currentSOItems = so.items || [];
        const defaultSOId = `SO${new Date().getFullYear()}${(salesOrders.length + 1).toString().padStart(3,'0')}${Math.random().toString(36).substr(2, 3).toUpperCase()}`;


        const formHtml = `
            <input type="hidden" id="soIdModal" value="${isNew ? '' : so.id}">
            <div class="form-group">
                <label for="soOrderIdModal" class="form-label">Order ID</label>
                <input type="text" id="soOrderIdModal" class="form-control" value="${isNew ? defaultSOId : so.orderId}" ${isNew ? '' : 'readonly'}>
            </div>
            <div class="form-group">
                <label for="soCustomerModal" class="form-label">Customer Name</label>
                <input type="text" id="soCustomerModal" class="form-control" value="${isNew ? 'Walk-in' : so.customer}" required>
            </div>
            <div class="form-group">
                <label for="soDateModal" class="form-label">Date</label>
                <input type="date" id="soDateModal" class="form-control" value="${isNew ? new Date().toISOString().split('T')[0] : (so.date && so.date.toDate ? so.date.toDate().toISOString().split('T')[0] : new Date().toISOString().split('T')[0])}" required>
            </div>
            <hr>
            <h5>Items</h5>
            <div id="so-items-container-modal">
                 ${currentSOItems.map(item => {
                    const recipe = recipes.find(r => r.id === item.recipeId);
                    const itemPriceDisplay = recipe ? (recipe.price || 0).toFixed(2) : '0.00';
                    return `
                    <div class="so-item d-flex align-items-center mb-2">
                        <select class="form-control so-item-recipe-modal mr-2 flex-grow-1" required>
                            ${recipes.map(rec => `<option value="${rec.id}" data-price="${rec.price || 0}" ${item.recipeId === rec.id ? 'selected' : ''}>${rec.name}</option>`).join('')}
                        </select>
                        <input type="number" class="form-control so-item-quantity-modal mr-2" style="max-width: 100px;" value="${item.quantity}" placeholder="Qty" min="1" step="1" required>
                        <span class="so-item-price-display-modal mr-2">@ ₹${itemPriceDisplay}</span>
                        <span class="remove-so-item-modal" title="Remove Item" style="cursor:pointer;"><i class="fas fa-times-circle text-danger"></i></span>
                    </div>`;
                }).join('')}
            </div>
            <button type="button" class="btn btn-sm btn-success mt-2" id="addSOItemBtnModal"><i class="fas fa-plus"></i> Add Item</button>
            <div class="form-group mt-3">
                <label for="soTotalAmountModal" class="form-label">Total Amount (₹)</label>
                <input type="text" id="soTotalAmountModal" class="form-control" value="${isNew ? '0.00' : (so.totalAmount || 0).toFixed(2)}" readonly>
            </div>
            <div class="form-group">
                <label for="soStatusModal" class="form-label">Status</label>
                <select id="soStatusModal" class="form-control">
                    <option value="Pending" ${isNew || (so && so.status === 'Pending') ? 'selected' : ''}>Pending</option>
                    <option value="Completed" ${so && so.status === 'Completed' ? 'selected' : ''}>Completed</option>
                    <option value="Cancelled" ${so && so.status === 'Cancelled' ? 'selected' : ''}>Cancelled</option>
                </select>
            </div>
        `;
        const footerHtml = `<button type="button" class="btn btn-primary" id="saveSOBtnModal">${isNew ? 'Create Order' : 'Update Order'}</button> <button type="button" class="btn" onclick="closeGenericModal()">Cancel</button>`;
        openGenericModal(isNew ? "Create Sales Order" : "Edit Sales Order", formHtml, footerHtml);

        const soItemsContainer = document.getElementById('so-items-container-modal');

        function addSOItemFieldHtml() {
            const div = document.createElement('div');
            div.className = 'so-item d-flex align-items-center mb-2 fade-in';
            const initialRecipePrice = recipes.length > 0 ? (recipes[0].price || 0).toFixed(2) : '0.00';
            div.innerHTML = `
                <select class="form-control so-item-recipe-modal mr-2 flex-grow-1" required>${recipeOptionsHtml}</select>
                <input type="number" class="form-control so-item-quantity-modal mr-2" style="max-width: 100px;" value="1" placeholder="Qty" min="1" step="1" required>
                <span class="so-item-price-display-modal mr-2">@ ₹${initialRecipePrice}</span>
                <span class="remove-so-item-modal" title="Remove Item" style="cursor:pointer;"><i class="fas fa-times-circle text-danger"></i></span>
            `;
            soItemsContainer.appendChild(div);
            div.querySelector('.remove-so-item-modal').addEventListener('click', () => { div.remove(); updateSOTotalModal(); });
            div.querySelector('.so-item-recipe-modal').addEventListener('change', (e) => {
                 const selectedOption = e.target.options[e.target.selectedIndex];
                 const price = parseFloat(selectedOption.dataset.price || 0).toFixed(2);
                 div.querySelector('.so-item-price-display-modal').textContent = `@ ₹${price}`;
                 updateSOTotalModal();
            });
            div.querySelector('.so-item-quantity-modal').addEventListener('input', updateSOTotalModal);
        }
        function updateSOTotalModal() {
            let total = 0;
            soItemsContainer.querySelectorAll('.so-item').forEach(item => {
                const recipeSelect = item.querySelector('.so-item-recipe-modal');
                const selectedOption = recipeSelect.options[recipeSelect.selectedIndex];
                const pricePerItem = parseFloat(selectedOption ? selectedOption.dataset.price : 0) || 0;
                const qty = parseFloat(item.querySelector('.so-item-quantity-modal').value) || 0;
                total += qty * pricePerItem;
            });
            const totalAmountEl = document.getElementById('soTotalAmountModal');
            if (totalAmountEl) totalAmountEl.value = total.toFixed(2);
        }

        document.getElementById('addSOItemBtnModal').addEventListener('click', addSOItemFieldHtml);
        if (isNew || currentSOItems.length === 0) {
            if (recipes.length > 0) addSOItemFieldHtml();
            else showToast("Please create recipes first before adding items to a Sales Order.", "warning", 4000);
        } else {
             soItemsContainer.querySelectorAll('.remove-so-item-modal').forEach(btn => {
                btn.addEventListener('click', () => { btn.closest('.so-item').remove(); updateSOTotalModal(); });
            });
            soItemsContainer.querySelectorAll('.so-item-recipe-modal, .so-item-quantity-modal').forEach(input => {
                input.addEventListener('change', updateSOTotalModal); // Use change for select, input for number
                if (input.type === 'number') input.addEventListener('input', updateSOTotalModal);
            });
        }
        updateSOTotalModal(); // Initial calculation
        document.getElementById('saveSOBtnModal').addEventListener('click', saveSO);
    };

    async function saveSO() {
        if (!isAuthReady || !userId) { showToast("Not authenticated. Cannot save SO.", "error"); return; }

        const id = document.getElementById('soIdModal').value;
        const orderIdNum = document.getElementById('soOrderIdModal').value.trim(); // This is the user-facing/generated ID
        const customer = document.getElementById('soCustomerModal').value.trim();
        const dateStr = document.getElementById('soDateModal').value;
        const status = document.getElementById('soStatusModal').value;

        if (!orderIdNum || !customer || !dateStr) { showToast("Order ID, Customer, and Date are required.", "error"); return; }
        if (!status) { showToast("Sales Order Status is required.", "error"); return; }

        const date = firebase.firestore.Timestamp.fromDate(new Date(dateStr));

        const items = [];
        let itemsValid = true;
        document.querySelectorAll('#so-items-container-modal .so-item').forEach(itemEl => {
            const recipeId = itemEl.querySelector('.so-item-recipe-modal').value;
            const quantity = parseFloat(itemEl.querySelector('.so-item-quantity-modal').value);
            if (!recipeId || isNaN(quantity) || quantity <= 0) {
                itemsValid = false;
            }
            items.push({ recipeId, quantity });
        });

        if (!itemsValid || items.length === 0) { showToast("Please add valid items (recipe and quantity > 0) to the Sales Order.", "error"); return; }

        const totalAmount = parseFloat(document.getElementById('soTotalAmountModal').value);
         if (isNaN(totalAmount) || totalAmount < 0) {
            showToast("Total amount calculation error or negative. Please check item prices and quantities.", "error"); return;
        }

        const soData = {
            orderId: orderIdNum, // Store the generated/user-facing ID
            customer, date, items, totalAmount, status,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        const soRef = getCollectionRef('salesOrders');
        if (!soRef) { showToast("Error: SO storage not found.", "error"); return; }

        try {
            if (id) { // Update existing SO (using Firestore doc ID)
                await soRef.doc(id).update(soData);
                showToast("Sales Order updated successfully!", "success");
            } else { // Create new SO
                soData.createdAt = firebase.firestore.FieldValue.serverTimestamp();
                await soRef.add(soData); // Firestore generates its own doc ID
                showToast("Sales Order created successfully!", "success");
            }
            closeGenericModal();
        } catch (error) {
            console.error("Error saving SO:", error);
            showToast("Error saving SO: " + error.message, "error");
        }
    }

    window.completeSalesOrder = async function(id) { // id is Firestore document ID
        if (!isAuthReady || !userId) { showToast("Not authenticated.", "error"); return; }
        const so = salesOrders.find(s => s.id === id);
        if (!so) { showToast("Sales Order not found.", "error"); return; }
        if (so.status === 'Completed') { showToast(`Sales Order ${so.orderId || id} is already completed.`, "info"); return; }
        if (so.status === 'Cancelled') { showToast(`Sales Order ${so.orderId || id} is cancelled and cannot be completed.`, "warning"); return; }


        openConfirmationModal("Complete Sales Order", `This will mark SO ${so.orderId || id} as 'Completed' and DEDUCT ingredients from stock. This is a critical step. Proceed?`, async () => {
            const soDocRef = getCollectionRef('salesOrders').doc(id);
            const batch = db.batch();
            let allIngredientsSufficient = true;
            let stockCheckMessages = [];

            // Preliminary check for stock sufficiency and prepare batch updates
            for (const item of so.items) {
                const recipe = recipes.find(r => r.id === item.recipeId);
                if (!recipe || !recipe.ingredients) {
                    stockCheckMessages.push(`Recipe ${item.recipeId} not found or has no ingredients.`);
                    allIngredientsSufficient = false;
                    continue;
                }
                for (const ing of recipe.ingredients) {
                    const material = rawMaterials.find(m => m.id === ing.materialId);
                    if (!material) {
                        stockCheckMessages.push(`Material ${ing.materialId} for recipe ${recipe.name} not found.`);
                        allIngredientsSufficient = false;
                        continue;
                    }
                    const requiredQty = ing.quantity * item.quantity;
                    if (material.stock < requiredQty) {
                        stockCheckMessages.push(`Insufficient stock for ${material.name}: need ${requiredQty}, have ${material.stock}.`);
                        allIngredientsSufficient = false;
                    } else {
                        // Prepare stock deduction
                        const materialDocRef = getCollectionRef('rawMaterials').doc(material.id);
                        batch.update(materialDocRef, {
                            stock: firebase.firestore.FieldValue.increment(-requiredQty)
                            // Consider updating material status if it becomes low stock
                        });
                    }
                }
            }

            if (!allIngredientsSufficient) {
                showToast("Cannot complete order: " + stockCheckMessages.join(" "), "error", 7000);
                return; // Stop if any stock issue
            }

            // If all checks pass, add SO completion to batch
            batch.update(soDocRef, {
                status: 'Completed',
                completedAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            try {
                await batch.commit();
                showToast(`Sales Order ${so.orderId || id} completed. Ingredients deducted from stock.`, "success");
                // UI will update via listeners
            } catch (error) {
                console.error("Error completing Sales Order:", error);
                showToast("Error completing SO: " + error.message, "error");
            }
        });
    };

    window.cancelSalesOrder = async function(id) { // id is Firestore document ID
        if (!isAuthReady || !userId) { showToast("Not authenticated.", "error"); return; }
        const so = salesOrders.find(s => s.id === id);
        if (!so) { showToast("Sales Order not found.", "error"); return; }
         if (so.status === 'Completed' || so.status === 'Cancelled') {
            showToast(`Sales Order ${so.orderId || id} is already ${so.status.toLowerCase()} and cannot be cancelled again.`, "info");
            return;
        }


        openConfirmationModal("Cancel Sales Order", `Are you sure you want to cancel SO ${so.orderId || id}? This action cannot be undone.`, async () => {
            const soDocRef = getCollectionRef('salesOrders').doc(id);
            try {
                await soDocRef.update({
                    status: 'Cancelled',
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                showToast(`Sales Order ${so.orderId || id} has been cancelled.`, "info");
            } catch (error) {
                console.error("Error cancelling SO:", error);
                showToast("Error cancelling SO: " + error.message, "error");
            }
        });
    };

    window.viewSalesOrder = function(id) { // id is Firestore document ID
        const order = salesOrders.find(s => s.id === id);
        if (!order) { showToast("Sales Order not found.", "error"); return; }

        const itemsSummary = order.items && order.items.length > 0 ? order.items.map(item => {
            const recipe = recipes.find(r => r.id === item.recipeId);
            const recipePrice = recipe ? (recipe.price || 0) : 0;
            const itemTotal = (item.quantity * recipePrice).toFixed(2);
            return `<li>${recipe ? recipe.name : `Recipe ${item.recipeId} not found`} (Qty: ${item.quantity}) @ ₹${recipePrice.toFixed(2)} each = ₹${itemTotal}</li>`;
        }).join('') : '<li>No items in this order.</li>';

        const date = order.date ? (order.date.toDate ? order.date.toDate().toLocaleDateString() : new Date(order.date).toLocaleDateString()) : 'N/A';
        const statusBadge = order.status === 'Pending' ? 'badge-warning' : (order.status === 'Completed' ? 'badge-success' : (order.status === 'Cancelled' ? 'badge-danger' : 'badge-info'));

        const contentHtml = `
            <h4>Order ID: ${order.orderId || `SO-${order.id.substring(0,5).toUpperCase()}`}</h4>
            <p><strong>Customer:</strong> ${order.customer || 'N/A'}</p>
            <p><strong>Date:</strong> ${date}</p>
            <p><strong>Status:</strong> <span class="badge ${statusBadge}">${order.status || 'N/A'}</span></p>
            <h5>Order Items:</h5>
            <ul>${itemsSummary}</ul>
            <p><strong>Total Amount: ₹${(order.totalAmount || 0).toFixed(2)}</strong></p>
            ${order.completedAt ? `<p><em>Completed on: ${order.completedAt.toDate().toLocaleString()}</em></p>` : ''}
        `;
        const footerHtml = `<button type="button" class="btn" onclick="closeGenericModal()">Close</button>`;
        openGenericModal(`View Sales Order: ${order.orderId || order.id}`, contentHtml, footerHtml);
    };

    // WASTE MANAGEMENT
    document.getElementById('add-waste-btn')?.addEventListener('click', () => editWasteRecord(null));

    window.editWasteRecord = function(id) { // id is Firestore doc ID or null
        const isNew = id === null;
        const record = isNew ? {} : wasteRecords.find(w => w.id === id);
        if (!isNew && !record) { showToast("Waste record not found.", "error"); return; }

        const materialOptions = rawMaterials.length > 0
            ? rawMaterials.map(mat => `<option value="${mat.id}" ${!isNew && record.materialId === mat.id ? 'selected' : ''}>${mat.name} (${mat.unit})</option>`).join('')
            : '<option value="">No materials available</option>';

        const formHtml = `
            <input type="hidden" id="wasteRecordIdModal" value="${isNew ? '' : record.id}">
            <div class="form-group">
                <label for="wasteDateModal" class="form-label">Date</label>
                <input type="date" id="wasteDateModal" class="form-control" value="${isNew ? new Date().toISOString().split('T')[0] : (record.date && record.date.toDate ? record.date.toDate().toISOString().split('T')[0] : new Date().toISOString().split('T')[0])}" required>
            </div>
            <div class="form-group">
                <label for="wasteMaterialIdModal" class="form-label">Material Wasted</label>
                <select id="wasteMaterialIdModal" class="form-control" required>${materialOptions}</select>
            </div>
            <div class="form-group">
                <label for="wasteQuantityModal" class="form-label">Quantity Wasted</label>
                <input type="number" id="wasteQuantityModal" class="form-control" value="${isNew ? '' : record.quantity}" min="0.01" step="any" required>
            </div>
            <div class="form-group">
                <label for="wasteReasonModal" class="form-label">Reason for Waste</label>
                <textarea id="wasteReasonModal" class="form-control" rows="3" required>${isNew ? '' : (record.reason || '')}</textarea>
            </div>
            <div class="form-group">
                <label for="wasteRecordedByModal" class="form-label">Recorded By</label>
                <input type="text" id="wasteRecordedByModal" class="form-control" value="${isNew ? 'Admin' : (record.recordedBy || 'Admin')}" required>
            </div>
        `;
        const footerHtml = `<button type="button" class="btn btn-primary" id="saveWasteRecordBtnModal">${isNew ? 'Log Waste' : 'Update Log'}</button> <button type="button" class="btn" onclick="closeGenericModal()">Cancel</button>`;
        openGenericModal(isNew ? "Log New Waste" : "Edit Waste Record", formHtml, footerHtml);
        document.getElementById('saveWasteRecordBtnModal').addEventListener('click', saveWasteRecord);
    };

    async function saveWasteRecord() {
        if (!isAuthReady || !userId) { showToast("Not authenticated.", "error"); return; }

        const id = document.getElementById('wasteRecordIdModal').value;
        const dateStr = document.getElementById('wasteDateModal').value;
        const materialId = document.getElementById('wasteMaterialIdModal').value;
        const quantity = parseFloat(document.getElementById('wasteQuantityModal').value);
        const reason = document.getElementById('wasteReasonModal').value.trim();
        const recordedBy = document.getElementById('wasteRecordedByModal').value.trim();

        if (!dateStr || !materialId || isNaN(quantity) || quantity <= 0 || !reason || !recordedBy) {
            showToast("Please fill all fields correctly (quantity must be > 0).", "error");
            return;
        }
        const materialWasted = rawMaterials.find(m => m.id === materialId);
        if (!materialWasted) {
            showToast("Selected material for waste not found.", "error"); return;
        }


        const wasteData = {
            date: firebase.firestore.Timestamp.fromDate(new Date(dateStr)),
            materialId,
            quantity,
            reason,
            recordedBy,
            materialName: materialWasted.name, // Denormalize for easier display if needed
            unit: materialWasted.unit,       // Denormalize for easier display
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        const wasteRef = getCollectionRef('wasteRecords');
        if (!wasteRef) { showToast("Error: Waste log storage not found.", "error"); return; }
        const materialDocRef = getCollectionRef('rawMaterials').doc(materialId);


        // Critical: Deduct from stock
        if (materialWasted.stock < quantity) {
            showToast(`Cannot log waste: Wasted quantity (${quantity}) exceeds stock (${materialWasted.stock}) for ${materialWasted.name}. Adjust stock or quantity.`, "error", 6000);
            return;
        }


        try {
            const batch = db.batch();
            // Deduct stock
            batch.update(materialDocRef, {
                stock: firebase.firestore.FieldValue.increment(-quantity)
                // Optionally update material status if it becomes low due to waste
            });

            if (id) { // Update existing waste log
                batch.update(wasteRef.doc(id), wasteData);
                await batch.commit();
                showToast("Waste record updated and stock adjusted.", "success");
            } else { // Add new waste log
                wasteData.createdAt = firebase.firestore.FieldValue.serverTimestamp();
                // For add, we need to do it in two steps if we are creating the waste record and updating stock
                // Or, do the stock update first, then add waste record.
                // For simplicity if using batch for adding a new doc and updating another:
                // This is tricky with batch.add. Let's do it sequentially for new records to ensure stock is updated.
                // If this was a single document update it would be fine.
                // So, for *new* waste record:
                // 1. Update stock.
                // 2. Add waste record.

                // For new records, it's simpler to not use batch for the add operation.
                if (!id) {
                    await materialDocRef.update({ stock: firebase.firestore.FieldValue.increment(-quantity) });
                    await wasteRef.add(wasteData);
                    showToast("Waste logged successfully and stock adjusted.", "success");
                } else { // For updates, batch is fine
                    await batch.commit(); // This path will only be taken if id exists
                    showToast("Waste record updated and stock adjusted.", "success");
                }

            }
            closeGenericModal();
        } catch (error) {
            console.error("Error saving waste record:", error);
            showToast("Error saving waste record: " + error.message, "error");
        }
    }

    window.deleteWasteRecord = async function(id) { // id is Firestore document ID
        if (!isAuthReady || !userId) { showToast("Not authenticated.", "error"); return; }
        const recordToDelete = wasteRecords.find(w => w.id === id);
        if (!recordToDelete) { showToast("Waste record not found.", "error"); return; }

        openConfirmationModal("Delete Waste Record", `Are you sure you want to delete this waste record? This will NOT automatically add stock back. Adjust stock manually if this deletion is to correct an error.`, async () => {
            const wasteRef = getCollectionRef('wasteRecords');
            if (!wasteRef) return;
            try {
                await wasteRef.doc(id).delete();
                showToast("Waste record deleted. Remember to adjust stock manually if needed.", "info", 5000);
            } catch (error) {
                console.error("Error deleting waste record:", error);
                showToast("Error: " + error.message, "error");
            }
        }, () => {
            showToast("Deletion cancelled.", "info");
        });
    };


    // --- Chart Initialization & Updates ---
// ==========================================================
// REPLACE this entire chart section in your script.js
// ==========================================================

// --- Chart Initialization & Updates ---
// ==========================================================
// REPLACE this entire chart section in your script.js
// ==========================================================

// --- Chart Initialization & Updates ---

function initCharts() {
    console.log("Initializing chart instances.");
    // Link dropdowns to their respective update functions
    document.getElementById('consumption-chart-type')?.addEventListener('change', updateConsumptionChart);
    document.getElementById('inventory-chart-type')?.addEventListener('change', updateInventoryReportChart);
    document.getElementById('waste-chart-type')?.addEventListener('change', updateWasteChart);
}

function updateAllCharts() {
    // Only redraw charts if the reports section is active to save resources
    if (document.getElementById('reports').classList.contains('active')) {
        updateConsumptionChart();
        updateInventoryReportChart();
        updateWasteChart();
    }
    // Update dashboard chart if it's visible
    if (document.getElementById('dashboard').classList.contains('active')) {
        updateInventoryChart();
    }
}

function updateInventoryChart() {
    const ctx = document.getElementById('inventoryChart')?.getContext('2d');
    if (!ctx) return;
    if (inventoryChartInstance) inventoryChartInstance.destroy(); // Destroy previous instance

    const data = {
        labels: rawMaterials.map(m => m.name),
        datasets: [{
            label: 'Current Stock',
            data: rawMaterials.map(m => m.stock),
            backgroundColor: rawMaterials.map(m => m.stock <= m.threshold ? 'rgba(255, 99, 132, 0.6)' : 'rgba(75, 192, 192, 0.6)'),
            borderColor: rawMaterials.map(m => m.stock <= m.threshold ? 'rgba(255, 99, 132, 1)' : 'rgba(75, 192, 192, 1)'),
            borderWidth: 1
        }, {
            label: 'Low Stock Threshold',
            data: rawMaterials.map(m => m.threshold),
            backgroundColor: 'rgba(255, 206, 86, 0.2)',
            borderColor: 'rgba(255, 206, 86, 1)',
            borderWidth: 1,
            type: 'line', // Show threshold as a line
            fill: false,
            tension: 0.1
        }]
    };
    inventoryChartInstance = new Chart(ctx, {
        type: 'bar', data, options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } }
    });
}


function updateConsumptionChart() {
    // FIXED: Using correct canvas ID 'consumptionChart' from your HTML
    const ctx = document.getElementById('consumptionChart')?.getContext('2d');
    if (!ctx) return;
    if (consumptionChartInstance) consumptionChartInstance.destroy();

    // Data aggregation logic (same as before)...
    const consumptionData = {};
    salesOrders.forEach(so => {
      if(so.status === 'Completed' && so.items){
        so.items.forEach(item => {
            const recipe = recipes.find(r => r.id === item.recipeId);
            if(recipe && recipe.ingredients){
                recipe.ingredients.forEach(ing => {
                    const material = rawMaterials.find(m => m.id === ing.materialId);
                    if(material){
                        consumptionData[material.name] = (consumptionData[material.name] || 0) + (ing.quantity * item.quantity);
                    }
                });
            }
        });
      }
    });
    const sortedConsumption = Object.entries(consumptionData).sort(([,a],[,b]) => b-a).slice(0, 10);
    const labels = sortedConsumption.map(([name,_]) => name);
    const dataValues = sortedConsumption.map(([_,qty]) => qty);

    consumptionChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Units Consumed',
                data: dataValues,
                backgroundColor: 'rgba(0, 184, 148, 0.7)',
            }]
        },
        options: {
            indexAxis: 'y', responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, title: { display: true, text: 'Top 10 Most Consumed Materials' } }
        }
    });
}

function updateInventoryReportChart() {
    // FIXED: Using correct canvas ID 'inventoryReportChart' from your HTML
    const ctx = document.getElementById('inventoryReportChart')?.getContext('2d');
    if (!ctx) return;
    if (inventoryReportChartInstance) inventoryReportChartInstance.destroy();

    // NEW: Logic to read the dropdown value
    const chartType = document.getElementById('inventory-chart-type')?.value || 'valueByCategory';
    let chartConfig;

    if (chartType === 'valueByCategory') {
        const valueByCategory = rawMaterials.reduce((acc, m) => {
            const category = m.category || 'Uncategorized';
            acc[category] = (acc[category] || 0) + ((m.stock || 0) * (m.costPerUnit || 0));
            return acc;
        }, {});
        chartConfig = {
            type: 'pie',
            data: {
                labels: Object.keys(valueByCategory),
                datasets: [{ label: 'Stock Value (₹)', data: Object.values(valueByCategory), backgroundColor: ['#6c5ce7', '#00b894', '#fdcb6e', '#0984e3', '#d63031'] }]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { title: { display: true, text: 'Stock Value by Category (₹)' } } }
        };
    } else { // lowStockVsThreshold
        const lowStockItems = rawMaterials.filter(m => parseFloat(m.stock) <= parseFloat(m.threshold));
        chartConfig = {
            type: 'bar',
            data: {
                labels: lowStockItems.map(item => item.name),
                datasets: [
                    { label: 'Current Stock', data: lowStockItems.map(item => item.stock), backgroundColor: '#fdcb6e' },
                    { label: 'Threshold', data: lowStockItems.map(item => item.threshold), backgroundColor: '#d63031' }
                ]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { title: { display: true, text: 'Low Stock Items vs. Threshold' } }, scales: { x: { stacked: false }, y: { stacked: false } } }
        };
    }
    inventoryReportChartInstance = new Chart(ctx, chartConfig);
}


function updateWasteChart() {
    // FIXED: Using correct canvas ID 'wasteChartCanvas' from your HTML
    const ctx = document.getElementById('wasteChartCanvas')?.getContext('2d');
    if (!ctx) return;
    if (wasteChartInstance) wasteChartInstance.destroy();

    // NEW: Logic to read the dropdown value
    const chartType = document.getElementById('waste-chart-type')?.value || 'byReason';
    let chartConfig;

    if (chartType === 'byReason') {
        const wasteByReason = wasteRecords.reduce((acc, record) => {
            const reason = record.reason || "Unspecified";
            acc[reason] = (acc[reason] || 0) + (record.quantity || 0);
            return acc;
        }, {});
        chartConfig = {
            type: 'doughnut',
            data: {
                labels: Object.keys(wasteByReason),
                datasets: [{ label: 'Waste by Reason', data: Object.values(wasteByReason), backgroundColor: ['#d63031', '#fdcb6e', '#0984e3', '#6c5ce7'] }]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { title: { display: true, text: 'Waste by Reason' } } }
        };
    } else { // byMaterial
        const wasteByMaterial = wasteRecords.reduce((acc, record) => {
            const materialName = rawMaterials.find(m => m.id === record.materialId)?.name || 'Unknown Material';
            acc[materialName] = (acc[materialName] || 0) + (record.quantity || 0);
            return acc;
        }, {});
        const sortedWaste = Object.entries(wasteByMaterial).sort(([,a],[,b]) => b-a).slice(0, 10);
        chartConfig = {
            type: 'bar',
            data: {
                labels: sortedWaste.map(([name,_]) => name),
                datasets: [{ label: 'Quantity Wasted', data: sortedWaste.map(([_,qty]) => qty), backgroundColor: 'rgba(214, 48, 49, 0.7)' }]
            },
            options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: {display: false}, title: { display: true, text: 'Top 10 Wasted Materials' } } }
        };
    }
    wasteChartInstance = new Chart(ctx, chartConfig);
}

    // --- START THE APP ---
    initializeFirebase(); // This will trigger auth and then data loading.
});
