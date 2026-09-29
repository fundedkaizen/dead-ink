import { CampaignStore } from './progress'
import { MISSION_IDS, mapFor, missionById } from './missions'
import type { MapModule } from './types'

/**
 * The map the hostage mission loads with: the one the chosen mission plays on (?mission= on the address, or the
 * campaign's saved choice). A map with its own build() (a real place, traced from OpenStreetMap) replaces the
 * compound's geometry; the compound map builds nothing here (main.ts builds it as before). Switching to a
 * mission on another map reloads the page onto that map (session.ts).
 */
export function bootMap(search = typeof location === 'undefined' ? '' : location.search): MapModule {
  const asked = missionById(new URLSearchParams(search).get('mission'))
  const mission = asked ?? missionById(new CampaignStore(MISSION_IDS).current().id)
  return mission ? mapFor(mission) : mapFor(missionById(MISSION_IDS[0])!)
}
