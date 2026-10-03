import { AppMetadata } from "@cab/contracts";
import hospitalJson from "../../../metadata/hospital.json";
import { SimulatedUiAdapter } from "./simulatedAdapter";

/**
 * Pre-parsed AppMetadata fixture from metadata/hospital.json.
 */
export const fakeHospitalMetadata: AppMetadata = AppMetadata.parse(hospitalJson);

/**
 * Helper to quickly instantiate a SimulatedUiAdapter seeded with the hospital metadata.
 */
export function createFakeUiAdapter(
  initialSessionId?: string,
  initialPageId: string = "medicines",
): SimulatedUiAdapter {
  const adapter = new SimulatedUiAdapter({
    metadata: fakeHospitalMetadata,
    defaultAppId: "hospital",
  });

  if (initialSessionId) {
    const page =
      fakeHospitalMetadata.pages.find((p) => p.id === initialPageId) ??
      fakeHospitalMetadata.pages[0];
    adapter.setState(initialSessionId, {
      appId: "hospital",
      pageId: page.id,
      route: page.route,
      filters: {},
      sort: null,
      selection: null,
      disabledFilters: [],
      version: 1,
    });
  }

  return adapter;
}
