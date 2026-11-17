(() => {
  const databaseName = "peerconnect-local";
  let databasePromise;

  function makeId() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function openDatabase() {
    if (!window.indexedDB) {
      return Promise.reject(new Error("This browser does not support local profile storage."));
    }
    if (databasePromise) return databasePromise;

    databasePromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(databaseName, 3);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("profiles")) {
          database.createObjectStore("profiles", { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains("projects")) {
          database.createObjectStore("projects", { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains("assets")) {
          database.createObjectStore("assets", { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains("history")) {
          database.createObjectStore("history", { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open local profile storage."));
      request.onblocked = () => reject(new Error("Profile storage is blocked by another open PeerConnect tab."));
    }).catch(error => {
      databasePromise = undefined;
      throw error;
    });

    return databasePromise;
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Could not save local data."));
      transaction.onabort = () => reject(transaction.error || new Error("The local data update was cancelled."));
    });
  }

  function historyEntry(type, title, detail = "", relatedId = null) {
    return {
      id: makeId(),
      type,
      title,
      detail,
      relatedId,
      createdAt: new Date().toISOString()
    };
  }

  async function getRecord(storeName, id) {
    const database = await openDatabase();
    const transaction = database.transaction(storeName, "readonly");
    const done = transactionDone(transaction);
    const request = transaction.objectStore(storeName).get(id);
    const result = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error || new Error("Could not read local data."));
    });
    await done;
    return result;
  }

  async function getAllRecords(storeName) {
    const database = await openDatabase();
    const transaction = database.transaction(storeName, "readonly");
    const done = transactionDone(transaction);
    const request = transaction.objectStore(storeName).getAll();
    const result = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not read local data."));
    });
    await done;
    return result;
  }

  async function saveProfile(profile, files = [], createOnly = false) {
    const database = await openDatabase();
    const transaction = database.transaction(["profiles", "assets", "history"], "readwrite");
    const done = transactionDone(transaction);
    const profileStore = transaction.objectStore("profiles");
    const assetStore = transaction.objectStore("assets");
    const historyStore = transaction.objectStore("history");
    let savedProfile;
    let duplicateProfile = false;

    const request = profileStore.get("current");
    request.onsuccess = () => {
      const existing = request.result;
      if (createOnly && existing) {
        duplicateProfile = true;
        transaction.abort();
        return;
      }

      const portfolioFiles = [...(existing?.portfolioFiles || [])];
      for (const file of files) {
        const asset = {
          id: makeId(),
          name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size,
          data: file,
          createdAt: new Date().toISOString()
        };
        assetStore.put(asset);
        portfolioFiles.push({
          id: asset.id,
          name: asset.name,
          type: asset.type,
          size: asset.size,
          createdAt: asset.createdAt
        });
        historyStore.put(historyEntry("portfolio-added", "Portfolio file added", file.name, asset.id));
      }

      savedProfile = {
        ...profile,
        id: "current",
        portfolioFiles,
        updatedAt: new Date().toISOString()
      };
      profileStore.put(savedProfile);
      historyStore.put(historyEntry(
        existing ? "profile-updated" : "profile-created",
        existing ? "Profile updated" : "Profile created",
        profile.name
      ));
    };

    try {
      await done;
    } catch (error) {
      if (duplicateProfile) throw new Error("A profile already exists. Open your dashboard to edit it.");
      throw error;
    }
    return savedProfile;
  }

  async function saveProject(project) {
    const database = await openDatabase();
    const transaction = database.transaction(["projects", "history"], "readwrite");
    const done = transactionDone(transaction);
    const record = {
      ...project,
      id: project.id || makeId(),
      createdAt: project.createdAt || new Date().toISOString()
    };
    transaction.objectStore("projects").put(record);
    transaction.objectStore("history").put(historyEntry("project-posted", "Project posted", record.title, record.id));
    await done;
    return record;
  }

  async function deleteProject(id) {
    const database = await openDatabase();
    const transaction = database.transaction(["projects", "history"], "readwrite");
    const done = transactionDone(transaction);
    const projects = transaction.objectStore("projects");
    const request = projects.get(id);
    request.onsuccess = () => {
      if (!request.result) return;
      projects.delete(id);
      transaction.objectStore("history").put(historyEntry("project-removed", "Project removed", request.result.title, id));
    };
    await done;
  }

  async function deleteAsset(id) {
    const database = await openDatabase();
    const transaction = database.transaction(["assets", "profiles", "history"], "readwrite");
    const done = transactionDone(transaction);
    const assets = transaction.objectStore("assets");
    const request = assets.get(id);
    request.onsuccess = () => {
      const asset = request.result;
      if (!asset) return;
      assets.delete(id);
      const profiles = transaction.objectStore("profiles");
      const profileRequest = profiles.get("current");
      profileRequest.onsuccess = () => {
        if (!profileRequest.result) return;
        const profile = profileRequest.result;
        profile.portfolioFiles = (profile.portfolioFiles || []).filter(file => file.id !== id);
        profile.updatedAt = new Date().toISOString();
        profiles.put(profile);
      };
      transaction.objectStore("history").put(historyEntry("portfolio-removed", "Portfolio file removed", asset.name, id));
    };
    await done;
  }

  window.PeerConnectDB = {
    getProfile: () => getRecord("profiles", "current"),
    createProfile: (profile, files = []) => saveProfile(profile, files, true),
    updateProfile: (profile, files = []) => saveProfile(profile, files),
    getProjects: () => getAllRecords("projects"),
    saveProject,
    deleteProject,
    getAssets: () => getAllRecords("assets"),
    deleteAsset,
    getHistory: async () => (await getAllRecords("history")).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  };
})();
