import { createContext, useContext } from 'react';

/**
 * What a generated project's panel needs from its conversation (ChatSection provides it): the conversation's id,
 * each project's latest version (heads: artifact id → version), whether edits can be sent now, and edit(), which
 * sends "what would you like to change?" as a follow-up on that project.
 */
export const ArtifactContext = createContext(null);
export const useArtifacts = () => useContext(ArtifactContext);
