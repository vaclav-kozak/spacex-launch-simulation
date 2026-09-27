// Global look values env publishes every frame for post (render/post reads them; nothing else should).

export const envLook = {
  /** 0 = day / twilight .. 1 = full night (pad sun below -18°). Moon, stars, airglow and city
   *  lights run with a NIGHT_GAIN boost scaled by this; artificial lights (plume, floods) do not. */
  night: 0,
  /** per view id: distance (m) from the camera to the view's focus body reference point, written in
   *  env.beforeViewRender (0 = no focus). Post uses it as the subject-depth hint for metering. */
  focusDist: new Map<string, number>(),
};
