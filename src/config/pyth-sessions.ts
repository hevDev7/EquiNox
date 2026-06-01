/* ============================================================
   Equinox — Pyth per-session equity feed IDs.

   Pyth publishes a SEPARATE feed for each US-equity trading session:
     Pre-Market (.PRE)  04:00–09:30 ET
     Regular   (no sfx) 09:30–16:00 ET   ← lives in src/config/stocks.ts (pythFeedId)
     Post-Market(.POST) 16:00–20:00 ET
     Overnight (.ON)    Sun 20:00 → Fri 04:00 ET (closed Sat + holidays)

   pyth.ts fetches every session a stock has and uses the freshest one (= the
   session currently trading), so the dashboard shows a live price ~24/5 instead
   of a frozen regular-hours close. Resolved from the Hermes catalogue
   (asset_type=equity) and id-length-validated. dV / dDIS / dNKE have NO extended
   sessions on Pyth → they correctly fall back to regular-hours last close.
   ============================================================ */

type Hex = `0x${string}`;

export interface SessionFeeds {
  pre?: Hex;
  post?: Hex;
  on?: Hex;
}

/** keyed by dShare symbol; only the 15 names with extended-hours feeds are listed. */
export const SESSION_FEEDS: Record<string, SessionFeeds> = {
  dTSLA: { pre: '0x42676a595d0099c381687124805c8bb22c75424dffcaa55e3dc6549854ebe20a', post: '0x2a797e196973b72447e0ab8e841d9f5706c37dc581fe66a0bd21bcd256cdb9b9', on: '0x713631e41c06db404e6a5d029f3eebfd5b885c59dce4a19f337c024e26584e26' },
  dAAPL: { pre: '0x8c320e4cd87c6cef41513aead15db413cf9253211923fef6e87187a7f6688906', post: '0x5a207c4aa0114baecf852fcd9db9beb8ec715f2db48caa525dbd878fd416fb09', on: '0x241b9a5ce1c3e4bfc68e377158328628f1b478afaa796c4b1760bd3713c2d2d2' },
  dNVDA: { pre: '0x61c4ca5b9731a79e285a01e24432d57d89f0ecdd4cd7828196ca8992d5eafef6', post: '0x25719379353a508b1531945f3c466759d6efd866f52fbaeb3631decb70ba381f', on: '0xc949a96fd1626e82abc5e1496e6e8d44683ac8ac288015ee90bf37257e3e6bf6' },
  dMSFT: { pre: '0xe8da97162840e7d6170094e0722900b1f2577dd1cc63cff10f91fc68a17eb2c9', post: '0x556b3e4dcc1c66448ba4054a0d9485545e3227ffc90a269f630620c5a38241ab', on: '0x8f98f8267ddddeeb61b4fd11f21dc0c2842c417622b4d685243fa73b5830131f' },
  dGOOGL: { pre: '0x43c3a42db1a663a22551d6c35d5bab823e86c1a05f27de3dd900e68952fce175', post: '0x88d0800b1649d98e21b8bf9c3f42ab548034d62874ad5d80e1c1b730566d7f61', on: '0x07d24bb76843496a45bce0add8b51555f2ea02098cb04f4c6d61f7b5720836b4' },
  dAMZN: { pre: '0x82c59e36a8e0247e15283748d6cd51f5fa1019d73fbf3ab6d927e17d9e357a7f', post: '0x62731dfcc8b8542e52753f208248c3e73fab2ec15422d6f65c2decda71ccea0d', on: '0x4ec1330b56eca05037c6b5a51d05f73db79bf3b4d29899881acd27966af184b4' },
  dMETA: { pre: '0xce0999c4f22f35f00e8f9913694868d00279c0b9efbd7cb1c358bf2fd76295c9', post: '0x399f1e8f1c4a517859963b56f104727a7a3c7f0f8fee56d34fa1f72e5a4b78ef', on: '0x783a457c2fe5642c96a66ba9a2fe61f511e9a0b539e0ed2a443321978e4d65a1' },
  dCOIN: { pre: '0x8bdee6bc9dc5a61b971e31dcfae96fc0c7eae37b2604aa6002ad22980bd3517c', post: '0x5c3bd92f2eed33779040caea9f82fac705f5121d26251f8f5e17ec35b9559cd4', on: '0x42ded7a3ed036606ab22ece1c942f6f9245a67f6f4ec27cfad5974d45fe9d6b6' },
  dAMD: { pre: '0x441bc31e56932a8764a3bdb90059ca540e41c669dc0641e38b57b5e0606301ed', post: '0x6969003ef4c5fbb3b57a6be3883102362d05572c2dc7f72b767ad48f4206204b', on: '0x7178689d88cdd76574b64438fc57f4e57efaf0bf5f9593ee19c10e46a3c5b5cf' },
  dNFLX: { pre: '0x81a3f7f89a88e9a0279b705f5a6670ad6d3702b9a7d3741423233a85d6758bab', post: '0xf3ae7810a11854aed92499250f89edd22409075dce2c17305fc33653522424c6', on: '0xa68f6030142bf1370f0963cd2d33b8aef33e4777a0331a63b383b88b2fd92dd7' },
  dPLTR: { pre: '0xbd8a8e449278ad0b6512695b1c558f816309f045d4e3da21dfc19448281840e8', post: '0xb11610f59456057d9bc82b0795c6d7aea6e2e075fc3e1991abc05e2b2861abb2', on: '0x3a4c922ec7e8cd86a6fa4005827e723a134a16f4ffe836eac91e7820c61f75a1' },
  dINTC: { pre: '0x1286070fae36dc773774de6e51d490bb70c84e3c541766125677ae5f8795dcb9', post: '0xc13d72c7cc29fc43ee51ff322803aaffd04611756e4e1a6ea03ed8d97d5602a3', on: '0x20e8ff9baf410664638c3ef80d091a13088cfcab442458e94642f39182cbff32' },
  dJPM: { pre: '0x112456efe1f916984631b5223a49c8f4d6f51e69410d2615315a3e080b3cd246', post: '0xf0580436732f61afa3bc1a499ab674c480d922da2ae76009ed301690fb996bed', on: '0x5f451bbe32545c6a157f547182878c4f3e00abd6a785db921761309180606f5a' },
  dBA: { pre: '0xd29a7daa6b0ab145996eef98e32db98fd2fa6b6811c2faf2ab5ab3c16a8134cd', post: '0x4147bcc254616726e61f4d831644b5204ad8c8b74d7346b4fa0ce1dc72e25aa9', on: '0x5d1ace0c1f064268a15a8f903a934050f835e69d003ac53a03646baf6394803b' },
  dMSTR: { pre: '0x1a11eb21c271f3127e4c9ec8a0e9b1042dc088ccba7a94a1a7d1aa37599a00f6', post: '0xd8b856d7e17c467877d2d947f27b832db0d65b362ddb6f728797d46b0a8b54c0', on: '0xc3055f49e1dc863a7f24d9b83e86fe10d7d16fb583bc6445505b01d230e0d647' },
};
