import memoize from 'memoizerific';
import React from 'react';
import deprecate from 'util-deprecate';
import dedent from 'ts-dedent';
import mapValues from 'lodash/mapValues';
import countBy from 'lodash/countBy';
import global from 'global';
import type {
  StoryId,
  ComponentTitle,
  StoryKind,
  StoryName,
  Args,
  ArgTypes,
  Parameters,
} from '@storybook/csf';
import { sanitize } from '@storybook/csf';

import { combineParameters } from '../index';
import merge from './merge';
import type { Provider } from '../modules/provider';
import type { ViewMode } from '../modules/addons';

const { FEATURES } = global;

export type { StoryId };

export interface Root {
  id: StoryId;
  depth: 0;
  name: string;
  refId?: string;
  children: StoryId[];
  isComponent: false;
  isRoot: true;
  isLeaf: false;
  renderLabel?: (item: Root) => React.ReactNode;
  startCollapsed?: boolean;
}

export interface Group {
  id: StoryId;
  depth: number;
  name: string;
  children: StoryId[];
  refId?: string;
  parent?: StoryId;
  isComponent: boolean;
  isRoot: false;
  isLeaf: false;
  renderLabel?: (item: Group) => React.ReactNode;
  // MDX docs-only stories are "Group" type
  parameters?: {
    docsOnly?: boolean;
    viewMode?: ViewMode;
  };
}

export interface Story {
  id: StoryId;
  depth: number;
  parent: StoryId;
  name: string;
  kind: StoryKind;
  refId?: string;
  children?: StoryId[];
  isComponent: boolean;
  isRoot: false;
  isLeaf: true;
  renderLabel?: (item: Story) => React.ReactNode;
  prepared: boolean;
  parameters?: {
    fileName: string;
    options: {
      [optionName: string]: any;
    };
    docsOnly?: boolean;
    viewMode?: ViewMode;
    [parameterName: string]: any;
  };
  args?: Args;
  argTypes?: ArgTypes;
  initialArgs?: Args;
}

export interface StoryInput {
  id: StoryId;
  name: string;
  refId?: string;
  kind: StoryKind;
  parameters: {
    fileName: string;
    options: {
      [optionName: string]: any;
    };
    docsOnly?: boolean;
    viewMode?: ViewMode;
    [parameterName: string]: any;
  };
  args?: Args;
  initialArgs?: Args;
}

export interface StoriesHash {
  [id: string]: Root | Group | Story;
}

export type StoriesList = (Group | Story)[];

export type GroupsList = (Root | Group)[];

export interface StoriesRaw {
  [id: string]: StoryInput;
}

type Path = string;
export interface StoryIndexStory {
  id: StoryId;
  name: StoryName;
  title: ComponentTitle;
  importPath: Path;
}
export interface StoryIndex {
  v: number;
  stories: Record<StoryId, StoryIndexStory>;
}

export type SetStoriesPayload =
  | {
      v: 2;
      error?: Error;
      globals: Args;
      globalParameters: Parameters;
      stories: StoriesRaw;
      kindParameters: {
        [kind: string]: Parameters;
      };
    }
  | ({
      v?: number;
      stories: StoriesRaw;
    } & Record<string, never>);

const warnLegacyShowRoots = deprecate(
  () => {},
  dedent`
    The 'showRoots' config option is deprecated and will be removed in Storybook 7.0. Use 'sidebar.showRoots' instead.
    Read more about it in the migration guide: https://github.com/storybookjs/storybook/blob/master/MIGRATION.md
  `
);

const warnChangedDefaultHierarchySeparators = deprecate(
  () => {},
  dedent`
    The default hierarchy separators changed in Storybook 6.0.
    '|' and '.' will no longer create a hierarchy, but codemods are available.
    Read more about it in the migration guide: https://github.com/storybookjs/storybook/blob/master/MIGRATION.md
  `
);

export const denormalizeStoryParameters = ({
  globalParameters,
  kindParameters,
  stories,
}: SetStoriesPayload): StoriesRaw => {
  return mapValues(stories, (storyData) => ({
    ...storyData,
    parameters: combineParameters(
      globalParameters,
      kindParameters[storyData.kind],
      storyData.parameters as unknown as Parameters
    ),
  }));
};

const STORY_KIND_PATH_SEPARATOR = /\s*\/\s*/;

export const transformStoryIndexToStoriesHash = (
  index: StoryIndex,
  { provider }: { provider: Provider }
): StoriesHash => {
  const countByTitle = countBy(Object.values(index.stories), 'title');
  const input = Object.entries(index.stories).reduce((acc, [id, { title, name, importPath }]) => {
    const docsOnly = name === 'Page' && countByTitle[title] === 1;
    acc[id] = {
      id,
      kind: title,
      name,
      parameters: { fileName: importPath, options: {}, docsOnly },
    };
    return acc;
  }, {} as StoriesRaw);

  return transformStoriesRawToStoriesHash(input, { provider, prepared: false });
};

export const transformStoriesRawToStoriesHash = (
  input: StoriesRaw,
  { provider, prepared = true }: { provider: Provider; prepared?: Story['prepared'] }
): StoriesHash => {
  const values = Object.values(input).filter(Boolean);
  const usesOldHierarchySeparator = values.some(({ kind }) => kind.match(/\.|\|/)); // dot or pipe

  const storiesHashOutOfOrder = values.reduce((acc, item) => {
    const { kind, parameters } = item;
    const { sidebar = {}, showRoots: deprecatedShowRoots } = provider.getConfig();
    const { showRoots = deprecatedShowRoots, collapsedRoots = [], renderLabel } = sidebar;

    if (typeof deprecatedShowRoots !== 'undefined') {
      warnLegacyShowRoots();
    }

    const setShowRoots = typeof showRoots !== 'undefined';
    if (usesOldHierarchySeparator && !setShowRoots && FEATURES?.warnOnLegacyHierarchySeparator) {
      warnChangedDefaultHierarchySeparators();
    }

    const groups = kind.trim().split(STORY_KIND_PATH_SEPARATOR);
    const root = (!setShowRoots || showRoots) && groups.length > 1 ? [groups.shift()] : [];

    const rootAndGroups = [...root, ...groups].reduce((list, name, index) => {
      const parent = index > 0 && list[index - 1].id;
      const id = sanitize(parent ? `${parent}-${name}` : name);

      if (parent === id) {
        throw new Error(
          dedent`
              Invalid part '${name}', leading to id === parentId ('${id}'), inside kind '${kind}'

              Did you create a path that uses the separator char accidentally, such as 'Vue <docs/>' where '/' is a separator char? See https://github.com/storybookjs/storybook/issues/6128
            `
        );
      }

      if (root.length && index === 0) {
        list.push({
          id,
          name,
          depth: index,
          children: [],
          isComponent: false,
          isLeaf: false,
          isRoot: true,
          renderLabel,
          startCollapsed: collapsedRoots.includes(id),
        });
      } else {
        list.push({
          id,
          name,
          parent,
          depth: index,
          children: [],
          isComponent: false,
          isLeaf: false,
          isRoot: false,
          renderLabel,
          parameters: {
            docsOnly: parameters?.docsOnly,
            viewMode: parameters?.viewMode,
          },
        });
      }

      return list;
    }, [] as GroupsList);

    const paths = [...rootAndGroups.map(({ id }) => id), item.id];

    // Ok, now let's add everything to the store
    rootAndGroups.forEach((group, index) => {
      const child = paths[index + 1];
      const { id } = group;
      acc[id] = merge(acc[id] || {}, {
        ...group,
        ...(child && { children: [child] }),
      });
    });

    acc[item.id] = {
      ...item,
      depth: rootAndGroups.length,
      parent: rootAndGroups[rootAndGroups.length - 1].id,
      isLeaf: true,
      isComponent: false,
      isRoot: false,
      renderLabel,
      prepared,
    };

    return acc;
  }, {} as StoriesHash);

  function addItem(acc: StoriesHash, item: Story | Group) {
    if (!acc[item.id]) {
      // If we were already inserted as part of a group, that's great.
      acc[item.id] = item;
      const { children } = item;
      if (children) {
        const childNodes = children.map((id) => storiesHashOutOfOrder[id]) as (Story | Group)[];
        acc[item.id].isComponent = childNodes.every((childNode) => childNode.isLeaf);
        childNodes.forEach((childNode) => addItem(acc, childNode));
      }
    }
    return acc;
  }

  return Object.values(storiesHashOutOfOrder).reduce(addItem, {});
};

export type Item = StoriesHash[keyof StoriesHash];

export function isRoot(item: Item): item is Root {
  if (item as Root) {
    return item.isRoot;
  }
  return false;
}
export function isGroup(item: Item): item is Group {
  if (item as Group) {
    return !item.isRoot && !item.isLeaf;
  }
  return false;
}
export function isStory(item: Item): item is Story {
  if (item as Story) {
    return item.isLeaf;
  }
  return false;
}

export const getComponentLookupList = memoize(1)((hash: StoriesHash) => {
  return Object.entries(hash).reduce((acc, i) => {
    const value = i[1];
    if (value.isComponent) {
      acc.push([...i[1].children]);
    }
    return acc;
  }, [] as StoryId[][]);
});

export const getStoriesLookupList = memoize(1)((hash: StoriesHash) => {
  return Object.keys(hash).filter((k) => !(hash[k].children || Array.isArray(hash[k])));
});
